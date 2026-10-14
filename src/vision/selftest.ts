// Таануу модулунун өзүн-өзү текшерүүсү (браузерсиз).
// Иштетүү: npx tsx src/vision/selftest.ts
//
// Синтетикалык 5 "жест" (ар башка траектория/кол формасы) түзүлөт: ызы-чуу, ылдамдык ±30%,
// өлчөм жана жылыш өзгөрүүлөрү менен. 5 үлгү менен окутуп, калганын таанытабыз.

import type { MocapClip, MocapFrame, SignEntry, Vec3 } from "../lib/types";
import { SignClassifier } from "./classifier";
import { FEATURE_DIM, RESAMPLE_N, clipFeatures, mirrorClip, mirrorFrame } from "./features";
import { assignHands } from "./handedness";
import { ClipRecorder, SignSegmenter } from "./segmenter";

// ───────────────────────── RNG ─────────────────────────
let seed = 12345;
function rnd(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uni = (a: number, b: number) => a + (b - a) * rnd();
function gauss(s = 1): number {
  const u = 1 - rnd(), v = rnd();
  return s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ───────────────────────── кол модели ─────────────────────────
type Curls = [number, number, number, number, number]; // thumb, index, middle, ring, pinky
const SHAPES: Record<string, Curls> = {
  flat: [0.3, 0, 0, 0, 0],
  five: [0, 0, 0, 0, 0],
  fist: [0.9, 1, 1, 1, 1],
  point: [0.8, 0, 1, 1, 1],
  v: [0.8, 0, 0, 1, 1],
  y: [0, 1, 1, 1, 0],
};

function rotY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}
function rotX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/** 21 чекит, колдун борборуна салыштырмалуу (handWorldLandmarks сыяктуу) */
function makeHand(curls: Curls, side: 1 | -1, orient: [number, number, number], size: number): Vec3[] {
  const pts: Vec3[] = [[0, 0, 0]];
  // бармак
  {
    let p: Vec3 = [side * 0.02, 0.025, 0.01];
    pts.push(p);
    const c = curls[0];
    const d0: Vec3 = [side * 0.7, 0.7, 0.1], d1: Vec3 = [-side * 0.5, 0.5, 0.7];
    let dir: Vec3 = [d0[0] + (d1[0] - d0[0]) * c, d0[1] + (d1[1] - d0[1]) * c, d0[2] + (d1[2] - d0[2]) * c];
    const n = Math.hypot(...dir); dir = [dir[0] / n, dir[1] / n, dir[2] / n];
    for (const len of [0.035, 0.03, 0.025]) {
      p = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
      pts.push(p);
    }
  }
  const baseX = [0.022, 0.002, -0.017, -0.033];
  const lens = [[0.045, 0.027, 0.022], [0.048, 0.03, 0.024], [0.045, 0.028, 0.022], [0.037, 0.021, 0.019]];
  for (let f = 0; f < 4; f++) {
    let p: Vec3 = [side * baseX[f], f === 3 ? 0.08 : 0.09, 0];
    pts.push(p);
    const c = curls[f + 1];
    for (let k = 0; k < 3; k++) {
      const th = (k + 1) * c * (Math.PI / 2) * 0.9;
      const spread = (f - 1.5) * 0.08 * (1 - c) * side;
      const dir: Vec3 = [Math.sin(-spread), Math.cos(th), Math.sin(th)];
      const len = lens[f][k];
      p = [p[0] + dir[0] * len, p[1] + dir[1] * len, p[2] + dir[2] * len];
      pts.push(p);
    }
  }
  let cx = 0, cy = 0, cz = 0;
  const out = pts.map((q) => {
    let v = rotZ(rotX(rotY(q, orient[1]), orient[0]), orient[2]);
    v = [v[0] * size, v[1] * size, v[2] * size];
    cx += v[0]; cy += v[1]; cz += v[2];
    return v;
  });
  return out.map((v) => [v[0] - cx / 21, v[1] - cy / 21, v[2] - cz / 21] as Vec3);
}

// ───────────────────────── дене ─────────────────────────
const REST_L: Vec3 = [0.2, -0.05, 0.05];
const REST_R: Vec3 = [-0.2, -0.05, 0.05];

function makePose(lw: Vec3, rw: Vec3): Vec3[] {
  const p: Vec3[] = new Array(33).fill(null).map(() => [0, 0.3, 0] as Vec3);
  const ls: Vec3 = [0.18, 0.5, 0], rs: Vec3 = [-0.18, 0.5, 0];
  p[0] = [0, 0.68, 0.08];
  for (let i = 1; i <= 10; i++) p[i] = [((i % 2) ? 1 : -1) * 0.03, 0.7, 0.06];
  p[11] = ls; p[12] = rs;
  const elbow = (s: Vec3, w: Vec3, out: number): Vec3 => [(s[0] + w[0]) / 2 + out * 0.06, (s[1] + w[1]) / 2 - 0.08, (s[2] + w[2]) / 2 - 0.03];
  p[13] = elbow(ls, lw, 1); p[14] = elbow(rs, rw, -1);
  p[15] = lw; p[16] = rw;
  for (const [i, w] of [[17, lw], [19, lw], [21, lw], [18, rw], [20, rw], [22, rw]] as [number, Vec3][]) p[i] = [w[0], w[1] + 0.05, w[2]];
  p[23] = [0.1, 0, 0]; p[24] = [-0.1, 0, 0];
  p[25] = [0.1, -0.45, 0]; p[26] = [-0.1, -0.45, 0];
  for (let i = 27; i < 33; i++) p[i] = [((i % 2) ? 1 : -1) * 0.1, -0.85, 0];
  return p;
}

// ───────────────────────── жесттер ─────────────────────────
interface HandSpec { pos: (u: number) => Vec3; shape: Curls; orient: [number, number, number] }
interface SignSpec { gloss: string; right?: HandSpec; left?: HandSpec; dur: number }

const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];

const SIGNS: SignSpec[] = [
  { gloss: "САЛАМ", dur: 900, right: { pos: (u) => lerp3([-0.1, 0.66, 0.15], [-0.32, 0.56, 0.35], u), shape: SHAPES.flat, orient: [0, 0, 0] } },
  { gloss: "РАХМАТ", dur: 1100, right: { pos: (u) => [-0.05 + 0.1 * Math.cos(2 * Math.PI * u), 0.35 + 0.1 * Math.sin(2 * Math.PI * u), 0.25], shape: SHAPES.flat, orient: [-1.2, 0, 0] } },
  { gloss: "ЖОК", dur: 1000, right: { pos: (u) => [-0.15 + 0.09 * Math.sin(4 * Math.PI * u), 0.6, 0.2], shape: SHAPES.point, orient: [0, 0, 0] } },
  {
    gloss: "ҮЙ", dur: 1000,
    right: { pos: (u) => lerp3([-0.03, 0.42, 0.25], [-0.26, 0.3, 0.22], u), shape: SHAPES.five, orient: [0, 0, 0.4] },
    left: { pos: (u) => lerp3([0.03, 0.42, 0.25], [0.26, 0.3, 0.22], u), shape: SHAPES.five, orient: [0, 0, -0.4] },
  },
  { gloss: "СУУ", dur: 1000, right: { pos: (u) => [-0.12, 0.3 + 0.12 * Math.sin(4 * Math.PI * u), 0.22], shape: SHAPES.fist, orient: [0, 0.5, 0] } },
];

interface Aug { speed: number; warp: number; amp: number; scale: number; hand: number; off: Vec3; yaw: number; noise: number; drop: number; fps: number }
function randomAug(): Aug {
  return {
    speed: uni(0.7, 1.3), warp: uni(-0.4, 0.4), amp: uni(0.85, 1.15), scale: uni(0.8, 1.2), hand: uni(0.85, 1.15),
    off: [uni(-0.1, 0.1), uni(-0.1, 0.1), uni(-0.1, 0.1)], yaw: uni(-0.15, 0.15), noise: 1, drop: 0.03, fps: uni(24, 31),
  };
}

/** Бир кадрды түзөт: u ∈ [0,1] жесттин ичиндеги фаза (null — колдор эс алууда) */
function makeFrame(t: number, spec: SignSpec | null, u: number, a: Aug, override?: { l?: Vec3 | null; r?: Vec3 | null; visible?: boolean }): MocapFrame {
  const amp = (h: HandSpec, base: Vec3): Vec3 => {
    const p = h.pos(u), c = h.pos(0.5);
    return [c[0] + (p[0] - c[0]) * a.amp + base[0], c[1] + (p[1] - c[1]) * a.amp + base[1], c[2] + (p[2] - c[2]) * a.amp + base[2]];
  };
  const lw: Vec3 = override?.l ?? (spec?.left ? amp(spec.left, [0, 0, 0]) : REST_L);
  const rw: Vec3 = override?.r ?? (spec?.right ? amp(spec.right, [0, 0, 0]) : REST_R);
  const noisy = (v: Vec3, s: number): Vec3 => [v[0] + gauss(s * a.noise), v[1] + gauss(s * a.noise), v[2] + gauss(s * a.noise)];
  const tf = (v: Vec3): Vec3 => {
    const r = rotY(v, a.yaw);
    return [r[0] * a.scale + a.off[0], r[1] * a.scale + a.off[1], r[2] * a.scale + a.off[2]];
  };
  const pose = makePose(lw, rw).map((v) => noisy(tf(v), 0.008));
  const hand = (h: HandSpec | undefined, side: 1 | -1, active: boolean): Vec3[] | null => {
    if (!active || !h || rnd() < a.drop) return null;
    const o: [number, number, number] = [h.orient[0] + gauss(0.08 * a.noise), h.orient[1] + a.yaw + gauss(0.08 * a.noise), h.orient[2] + gauss(0.08 * a.noise)];
    return makeHand(h.shape, side, o, a.hand * a.scale).map((v) => noisy(v, 0.003));
  };
  const vis = override?.visible ?? true;
  return {
    t,
    pose,
    leftHand: hand(spec?.left, -1, vis && !!spec?.left),
    rightHand: hand(spec?.right, 1, vis && !!spec?.right),
    face: null,
  };
}

function makeClip(spec: SignSpec, a: Aug = randomAug()): MocapClip {
  const dur = spec.dur * a.speed;
  const dt = 1000 / a.fps;
  const frames: MocapFrame[] = [];
  for (let t = 0; t <= dur; t += dt) {
    let u = t / dur;
    u = u + a.warp * u * (1 - u);
    frames.push(makeFrame(t, spec, u, a));
  }
  return { kind: "mocap", fps: a.fps, frames };
}

/** Кокус жест: эки колдун кокус басылышы, кокус формасы */
function randomGesture(): MocapClip {
  const curls = (): Curls => [rnd(), rnd(), rnd(), rnd(), rnd()];
  const walk = (start: Vec3) => {
    const pts: Vec3[] = [start];
    for (let i = 0; i < 6; i++) { const p = pts[pts.length - 1]; pts.push([p[0] + uni(-0.15, 0.15), p[1] + uni(-0.15, 0.15), p[2] + uni(-0.1, 0.1)]); }
    return (u: number): Vec3 => { const x = u * 6, i = Math.min(5, Math.floor(x)); return lerp3(pts[i], pts[i + 1], x - i); };
  };
  const twoHands = rnd() < 0.5;
  const spec: SignSpec = {
    gloss: "?", dur: uni(700, 1400),
    right: { pos: walk([uni(-0.3, 0), uni(0.15, 0.7), uni(0.05, 0.35)]), shape: curls(), orient: [uni(-1.5, 1.5), uni(-1.5, 1.5), uni(-1, 1)] },
    left: twoHands ? { pos: walk([uni(0, 0.3), uni(0.15, 0.7), uni(0.05, 0.35)]), shape: curls(), orient: [uni(-1.5, 1.5), uni(-1.5, 1.5), uni(-1, 1)] } : undefined,
  };
  return makeClip(spec);
}

// ───────────────────────── текшерүүлөр ─────────────────────────
let failures = 0;
function check(name: string, ok: boolean, info = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`);
  if (!ok) failures++;
}

function entry(gloss: string, samples: MocapClip[]): SignEntry {
  return { gloss, aliases: [], clip: samples[0], samples, source: "recorded", createdAt: 0 };
}

// 1) Белгилер: өлчөмү жана инварианттуулугу
{
  const a = randomAug();
  const base = makeClip(SIGNS[0], { ...a, noise: 0, drop: 0 });
  const f1 = clipFeatures(base)!;
  // ошол эле клип, 1.3 эсе чоң адам + жылыш
  const scaled: MocapClip = {
    ...base,
    frames: base.frames.map((f) => ({
      ...f,
      pose: f.pose!.map((v) => [v[0] * 1.3 + 0.2, v[1] * 1.3 - 0.1, v[2] * 1.3 + 0.3] as Vec3),
      rightHand: f.rightHand && f.rightHand.map((v) => [v[0] * 1.3, v[1] * 1.3, v[2] * 1.3] as Vec3),
    })),
  };
  const f2 = clipFeatures(scaled)!;
  let maxd = 0;
  for (let i = 0; i < f1.length; i++) maxd = Math.max(maxd, Math.abs(f1[i] - f2[i]));
  check("features: length N×D", f1.length === RESAMPLE_N * FEATURE_DIM, `${RESAMPLE_N}×${FEATURE_DIM}`);
  check("features: scale/translation invariant", maxd < 1e-4, `max |Δ| = ${maxd.toExponential(2)}`);
  const mm = mirrorFrame(mirrorFrame(base.frames[3]));
  check("mirrorFrame is an involution", JSON.stringify(mm) === JSON.stringify(base.frames[3]));
}

// 2) Классификация
const TRAIN = 5, TEST = 20;
const clf = new SignClassifier();
const entries = SIGNS.map((s) => entry(s.gloss, Array.from({ length: TRAIN }, () => makeClip(s))));
entries.push(entry("БОШ", [])); // үлгүсү жок — эске алынбашы керек
let t0 = performance.now();
clf.train(entries);
const trainMs = performance.now() - t0;
check("vocabulary ignores entries without samples", clf.vocabulary.length === SIGNS.length, clf.vocabulary.join(", "));

let correct = 0, total = 0, confSum = 0, confMin = 1;
const confusion: Record<string, Record<string, number>> = {};
for (const s of SIGNS) {
  confusion[s.gloss] = {};
  for (let i = 0; i < TEST; i++) {
    const r = clf.classify(makeClip(s));
    total++;
    if (r?.gloss === s.gloss) { correct++; confSum += r.confidence; confMin = Math.min(confMin, r.confidence); }
    const g = r?.gloss ?? "null";
    confusion[s.gloss][g] = (confusion[s.gloss][g] ?? 0) + 1;
  }
}
const acc = correct / total;
check("held-out accuracy ≥ 90%", acc >= 0.9, `${correct}/${total} = ${(acc * 100).toFixed(1)}%, mean conf (correct) ${(confSum / Math.max(1, correct)).toFixed(3)}, min ${confMin.toFixed(3)}; train ${trainMs.toFixed(0)} ms`);
if (acc < 1) console.log("      confusion:", JSON.stringify(confusion));

let rejected = 0, maxRandConf = 0;
const RAND = 20;
for (let i = 0; i < RAND; i++) {
  const r = clf.classify(randomGesture());
  const c = r?.confidence ?? 0;
  maxRandConf = Math.max(maxRandConf, c);
  if (c < 0.5) rejected++;
}
check("random gestures rejected (conf < 0.5)", rejected >= RAND * 0.9, `${rejected}/${RAND} rejected, max conf ${maxRandConf.toFixed(3)}`);

check("too-short segment → null", clf.classify({ kind: "mocap", fps: 30, frames: makeClip(SIGNS[0]).frames.slice(0, 2) }) === null);
check("untrained classifier → null", new SignClassifier().classify(makeClip(SIGNS[0])) === null);

// Сол колдуу колдонуучу: күзгүлөнгөн клиптер + leftHanded
{
  const lh = new SignClassifier({ leftHanded: true });
  lh.train(entries);
  let ok = 0;
  for (const s of SIGNS) for (let i = 0; i < 5; i++) if (lh.classify(mirrorClip(makeClip(s)))?.gloss === s.gloss) ok++;
  check("left-handed (mirrored) signer recognised", ok >= 0.9 * 5 * SIGNS.length, `${ok}/${5 * SIGNS.length}`);
}

// 3) Ылдамдык: 100 жест × 8 үлгү
{
  const big: SignEntry[] = [];
  const specs: SignSpec[] = [];
  for (let c = 0; c < 100; c++) {
    const shapes = Object.values(SHAPES);
    const a: Vec3 = [uni(-0.3, 0), uni(0.2, 0.7), uni(0.1, 0.35)], b: Vec3 = [uni(-0.3, 0), uni(0.2, 0.7), uni(0.1, 0.35)];
    const f = Math.floor(uni(0, 3));
    const spec: SignSpec = {
      gloss: "G" + c, dur: uni(700, 1300),
      right: { pos: (u) => { const p = lerp3(a, b, u); return [p[0] + 0.05 * Math.sin(2 * Math.PI * f * u), p[1] + 0.05 * Math.cos(2 * Math.PI * f * u), p[2]]; }, shape: shapes[c % shapes.length], orient: [uni(-1, 1), uni(-1, 1), 0] },
    };
    specs.push(spec);
    big.push(entry(spec.gloss, Array.from({ length: 8 }, () => makeClip(spec))));
  }
  const bc = new SignClassifier();
  t0 = performance.now();
  bc.train(big);
  const tTrain = performance.now() - t0;
  const queries = specs.slice(0, 20).map((s) => makeClip(s));
  bc.classify(queries[0]); // жылытуу
  t0 = performance.now();
  let ok = 0;
  queries.forEach((q, i) => { if (bc.classify(q)?.gloss === specs[i].gloss) ok++; });
  const per = (performance.now() - t0) / queries.length;
  check("speed: 100 signs × 8 samples, classify < 50 ms", per < 50, `${per.toFixed(1)} ms/query (train ${tTrain.toFixed(0)} ms, accuracy ${ok}/20)`);
}

// 4) Сегментатор: тыныгуулар менен үзгүлтүксүз агым
{
  const fps = 30, dt = 1000 / fps;
  const stream: MocapFrame[] = [];
  const truth: string[] = [];
  let t = 0;
  const rest = (ms: number, a: Aug) => { for (const end = t + ms; t < end; t += dt) stream.push(makeFrame(t, null, 0, a)); };
  const a0 = { ...randomAug(), off: [0, 0, 0] as Vec3, yaw: 0, scale: 1, drop: 0.02 };
  rest(800, a0);
  const order = [0, 1, 2, 3, 4, 2, 0];
  for (const k of order) {
    const s = SIGNS[k];
    truth.push(s.gloss);
    const a = { ...randomAug(), off: [0, 0, 0] as Vec3, yaw: 0, scale: 1, drop: 0.02 };
    const ampP = (h: HandSpec | undefined, u: number, rest: Vec3): Vec3 => {
      if (!h) return rest;
      const p = h.pos(u), c = h.pos(0.5);
      return [c[0] + (p[0] - c[0]) * a.amp, c[1] + (p[1] - c[1]) * a.amp, c[2] + (p[2] - c[2]) * a.amp];
    };
    // көтөрүү 250 мс
    for (let u = 0, end = t + 250; t < end; t += dt, u = Math.min(1, u + dt / 250))
      stream.push(makeFrame(t, s, 0, a, { l: lerp3(REST_L, ampP(s.left, 0, REST_L), u), r: lerp3(REST_R, ampP(s.right, 0, REST_R), u) }));
    const dur = s.dur * a.speed;
    for (let tt = 0; tt <= dur; tt += dt, t += dt) stream.push(makeFrame(t, s, tt / dur, a));
    // түшүрүү 250 мс
    for (let u = 0, end = t + 250; t < end; t += dt, u = Math.min(1, u + dt / 250))
      stream.push(makeFrame(t, s, 1, a, { l: lerp3(ampP(s.left, 1, REST_L), REST_L, u), r: lerp3(ampP(s.right, 1, REST_R), REST_R, u), visible: u < 0.6 }));
    rest(uni(500, 900), a0);
  }
  const seg = new SignSegmenter({ minMs: 300, restMs: 400 });
  const segs: MocapClip[] = [];
  let sawActive = false;
  for (const f of stream) {
    const c = seg.push(f);
    if (seg.active) sawActive = true;
    if (c) segs.push(c);
  }
  check("segmenter: correct number of segments", segs.length === truth.length, `${segs.length} segments for ${truth.length} signs, durations ${segs.map((c) => Math.round(c.frames[c.frames.length - 1].t)).join("/")} ms`);
  check("segmenter: clips rebased to t=0 with fps", segs.every((c) => c.frames[0].t === 0 && c.fps > 20 && c.fps < 40) && sawActive);
  const labels = segs.map((c) => clf.classify(c)?.gloss ?? "null");
  const segOk = labels.filter((g, i) => g === truth[i]).length;
  check("segmented stream classified", segOk >= truth.length - 1, `${labels.join(" ")}  (truth: ${truth.join(" ")})`);

  // Колдор абада кыймылсыз калса — сегмент бүтүшү керек, кайра кыймылсыз башталбашы керек
  const seg2 = new SignSegmenter();
  const a = { ...randomAug(), drop: 0 };
  let n2 = 0; t = 0;
  rest(400, a);
  const s0 = SIGNS[0];
  for (let tt = 0; tt <= 900; tt += dt, t += dt) stream.push(makeFrame(t, s0, tt / 900, a));
  const hold: MocapFrame[] = [];
  for (let k = 0; k < 60; k++, t += dt) hold.push(makeFrame(t, s0, 1, { ...a, noise: 0.3 }));
  for (const f of [...stream.slice(-Math.ceil(900 / dt) - 1), ...hold]) if (seg2.push(f)) n2++;
  check("segmenter: still hold ends segment once", n2 === 1 && !seg2.active, `${n2} segment(s)`);
}

// 5) Колдорду бөлүштүрүү
{
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
  pose[15] = { x: 0.7, y: 0.4, visibility: 1 }; // адамдын сол билеги — сүрөттүн оң жагында
  pose[16] = { x: 0.3, y: 0.45, visibility: 1 };
  const a1 = assignHands({ wrists: [{ x: 0.69, y: 0.41 }], labels: ["Right"], pose });
  check("hands: wrist proximity", a1.sides[0] === "left" && a1.method[0] === "wrist");
  const a2 = assignHands({ wrists: [{ x: 0.31, y: 0.44 }, { x: 0.71, y: 0.4 }], labels: ["Right", "Right"], pose });
  check("hands: two hands by wrists", a2.sides[0] === "right" && a2.sides[1] === "left");
  const a3 = assignHands({ wrists: [{ x: 0.7, y: 0.4 }], labels: ["Right"], pose: null });
  check("hands: label fallback flipped for unmirrored feed", a3.sides[0] === "left" && a3.method[0] === "label");
  const a4 = assignHands({ wrists: [{ x: 0.2, y: 0.4 }, { x: 0.8, y: 0.4 }], labels: ["Left", "Left"], pose: null });
  check("hands: duplicate labels → image position", a4.sides[0] === "right" && a4.sides[1] === "left");
}

// 6) ClipRecorder
{
  const rec = new ClipRecorder();
  rec.start();
  const c = makeClip(SIGNS[1]);
  for (const f of c.frames) rec.push({ ...f, t: f.t + 5000 });
  const out = rec.stop();
  check("ClipRecorder: rebased + fps", out.frames[0].t === 0 && Math.abs(out.fps - c.fps) < 2 && !rec.recording, `fps ${out.fps}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
