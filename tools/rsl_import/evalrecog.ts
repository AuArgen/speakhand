// Recognition check of the library templates (no AI): perturbed library clips → SignClassifier with
// the precomputed bank (public/signs/rsl/templates.*), exactly as the browser loads it.
//   npx tsx tools/rsl_import/evalrecog.ts [count=200]
// Perturbations per query: non-uniform time warp (local speed ±25 %) and overall duration ±25 %,
// resampled to 25 fps; scale ±10 %; rotation about the vertical axis ±10°; translation ±5 cm;
// Gaussian noise (pose 5 mm, hands 2 mm). Second pass also crops 0–8 % at both ends (segmenter jitter).
// Also: leave-one-variant-out (LOVO) for glosses that have ≥ 2 library clips.
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeClip, type EncodedClip } from "../../src/data/clipCodec";
import type { MocapClip, MocapFrame, Vec3 } from "../../src/lib/types";
import { SignClassifier, decodeTemplateBank, type TemplateBank, type TemplateIndex } from "../../src/vision/classifier";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RSL = path.join(ROOT, "public/signs/rsl");
const COUNT = Number(process.argv[2] ?? 200);

let seed = 20261014;
function rnd(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const uni = (a: number, b: number) => a + (b - a) * rnd();
const gauss = (s: number) => s * Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

interface Item { id: string; gloss: string; clip: string }
const man = JSON.parse(readFileSync(path.join(RSL, "manifest.json"), "utf8")) as { items: Item[] };
const index = JSON.parse(readFileSync(path.join(RSL, "templates.json"), "utf8")) as TemplateIndex;
const bin = readFileSync(path.join(RSL, "templates.bin"));
const t0 = performance.now();
const bank = decodeTemplateBank(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const tDecode = performance.now() - t0;
const loadClip = (it: Item) => decodeClip(JSON.parse(readFileSync(path.join(RSL, it.clip), "utf8")) as EncodedClip);

function sampleAt(c: MocapClip, t: number): MocapFrame {
  const f = c.frames;
  if (t <= f[0].t) return f[0];
  if (t >= f[f.length - 1].t) return f[f.length - 1];
  let i = 0;
  while (f[i + 1].t < t) i++;
  const a = f[i], b = f[i + 1], u = (t - a.t) / (b.t - a.t);
  const lerp = (p: Vec3[] | null, q: Vec3[] | null): Vec3[] | null =>
    !p || !q ? (u < 0.5 ? p : q) : p.map((v, k) => [v[0] + (q[k][0] - v[0]) * u, v[1] + (q[k][1] - v[1]) * u, v[2] + (q[k][2] - v[2]) * u] as Vec3);
  return { t, pose: lerp(a.pose, b.pose), leftHand: lerp(a.leftHand, b.leftHand), rightHand: lerp(a.rightHand, b.rightHand), face: a.face };
}

function perturb(c: MocapClip, crop: boolean): MocapClip {
  const T = c.frames.at(-1)!.t;
  const c0 = crop ? uni(0, 0.08) * T : 0, c1 = crop ? T - uni(0, 0.08) * T : T;
  const dur = (c1 - c0) * uni(0.75, 1.25);
  const a = uni(-0.08, 0.08); // local speed 1 ± a·π ≈ ±25 %
  const s = uni(0.9, 1.1), th = (uni(-10, 10) * Math.PI) / 180, tr: Vec3 = [uni(-0.05, 0.05), uni(-0.05, 0.05), uni(-0.05, 0.05)];
  const cs = Math.cos(th), sn = Math.sin(th);
  const xf = (p: Vec3, noise: number, move: boolean): Vec3 => {
    const x = p[0] * s, y = p[1] * s, z = p[2] * s;
    return [x * cs + z * sn + (move ? tr[0] : 0) + gauss(noise), y + (move ? tr[1] : 0) + gauss(noise), -x * sn + z * cs + (move ? tr[2] : 0) + gauss(noise)];
  };
  const fps = 25, frames: MocapFrame[] = [];
  for (let k = 0; k * (1000 / fps) <= dur; k++) {
    const u = (k * (1000 / fps)) / dur;
    const f = sampleAt(c, c0 + (c1 - c0) * Math.min(1, Math.max(0, u + a * Math.sin(Math.PI * u))));
    frames.push({
      t: k * (1000 / fps),
      pose: f.pose?.map((p) => xf(p, 0.005, true)) ?? null,
      leftHand: f.leftHand?.map((p) => xf(p, 0.002, false)) ?? null,
      rightHand: f.rightHand?.map((p) => xf(p, 0.002, false)) ?? null,
      face: f.face,
    });
  }
  return { kind: "mocap", fps, frames };
}

const debugRows: string[] = [];
function evaluate(clf: SignClassifier, tests: { gloss: string; clip: MocapClip }[]) {
  let top1 = 0, top5 = 0, confOk = 0, nul = 0;
  const times: number[] = [];
  const confs: number[] = [];
  for (const t of tests) {
    const a = performance.now();
    const r = clf.classify(t.clip);
    times.push(performance.now() - a);
    if (!r) { nul++; continue; }
    const ranked = [r.gloss, ...r.alternatives.map((x) => x.gloss)];
    if (ranked[0] === t.gloss) { top1++; confs.push(r.confidence); if (r.confidence >= 0.55) confOk++; }
    if (process.env.DEBUG) debugRows.push(`${t.gloss} → ${r.gloss} ${r.confidence} alt ${r.alternatives.slice(0, 2).map((a) => a.gloss + " " + a.confidence).join(", ")}`);
    if (ranked.slice(0, 5).includes(t.gloss)) top5++;
  }
  times.sort((x, y) => x - y);
  const n = tests.length;
  confs.sort((x, y) => x - y);
  return {
    top1: top1 / n, top5: top5 / n, nul,
    acceptedCorrect: confOk / n,
    confMedian: confs[confs.length >> 1] ?? 0,
    msMean: times.reduce((x, y) => x + y, 0) / n, msP95: times[Math.floor(n * 0.95)], msMax: times[n - 1],
  };
}
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

// ── full bank ──
const clf = new SignClassifier(process.env.MARGIN ? { softmaxMargin: Number(process.env.MARGIN) } : {});
const t1 = performance.now();
clf.addTemplates(bank);
const tAdd = performance.now() - t1;
console.log(`bank: ${bank.rows.length} templates, ${bank.glosses.length} glosses; decode ${tDecode.toFixed(0)} ms, addTemplates (envelopes + calibration) ${tAdd.toFixed(0)} ms`);
console.log(`calibration: temperature ${clf.stats.temperature.toFixed(3)}`);

const pick: Item[] = [];
const pool = man.items.slice();
while (pick.length < Math.min(COUNT, pool.length)) pick.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
const clips = new Map(pick.map((it) => [it.id, loadClip(it)]));
clf.classify(perturb(clips.get(pick[0].id)!, false)); // warm-up (JIT)

for (const crop of [false, true]) {
  const tests = pick.map((it) => ({ gloss: it.gloss, clip: perturb(clips.get(it.id)!, crop) }));
  const r = evaluate(clf, tests);
  console.log(`perturbed${crop ? " + crop 0–8 %" : ""} (${tests.length}): top-1 ${pct(r.top1)}, top-5 ${pct(r.top5)}, correct & conf ≥ 0.55 ${pct(r.acceptedCorrect)} (median conf ${r.confMedian.toFixed(2)}), null ${r.nul}; classify ${r.msMean.toFixed(1)} ms mean, p95 ${r.msP95.toFixed(1)}, max ${r.msMax.toFixed(1)}`);
}

if (process.env.DEBUG) console.log(debugRows.filter((r) => / 0\.[0-4]\d* alt/.test(r)).slice(0, 15).join("\n"));
// ── unknown movements: first half of clip A + second half of clip B (different glosses) ──
{
  let accepted = 0, total = 0;
  for (let i = 0; i + 1 < pick.length; i += 2) {
    const a = clips.get(pick[i].id)!, b = clips.get(pick[i + 1].id)!;
    if (pick[i].gloss === pick[i + 1].gloss) continue;
    const ha = a.frames.slice(0, a.frames.length >> 1), hb = b.frames.slice(b.frames.length >> 1);
    const dt = 1000 / a.fps;
    const frames = [...ha, ...hb].map((f, k) => ({ ...f, t: k * dt }));
    const r = clf.classify(perturb({ kind: "mocap", fps: a.fps, frames }, false));
    total++;
    if (r && r.confidence >= 0.55) accepted++;
  }
  console.log(`unknown (spliced halves of two different signs, ${total}): accepted with conf ≥ 0.55: ${pct(accepted / total)}`);
}

// ── leave-one-variant-out ──
const byGloss = new Map<string, number[]>();
for (let r = 0; r < bank.rows.length; r++) {
  const g = bank.glosses[bank.rows[r]];
  byGloss.set(g, [...(byGloss.get(g) ?? []), r]);
}
const held = new Set<number>();
for (const rows of byGloss.values()) if (rows.length >= 2) held.add(rows[Math.floor(rnd() * rows.length)]);
const keep = [...Array(bank.rows.length).keys()].filter((r) => !held.has(r));
const size = bank.n * bank.dims;
const sub: TemplateBank = {
  ...bank,
  rows: keep.map((r) => bank.rows[r]),
  data: (() => { const d = new Float32Array(keep.length * size); keep.forEach((r, i) => d.set(bank.data.subarray(r * size, (r + 1) * size), i * size)); return d; })(),
};
const lovo = new SignClassifier();
lovo.addTemplates(sub);
const byId = new Map(man.items.map((it) => [it.id, it]));
const tests = [...held].map((r) => { const it = byId.get(bank.ids![r])!; return { gloss: it.gloss, clip: loadClip(it) }; });
const r = evaluate(lovo, tests);
console.log(`leave-one-variant-out (${tests.length} glosses with ≥ 2 clips; the other variant may be a different sign): top-1 ${pct(r.top1)}, top-5 ${pct(r.top5)}`);
