// Shared pieces of the replay harnesses (livereplay.ts, utterreplay.ts): cached lesson streams
// (cache/stream/lNN.json from dumpstream.py), the template bank, landmark-space perturbations.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { MocapFrame, Vec3 } from "../../src/lib/types";
import { decodeTemplateBank, type TemplateBank, type TemplateIndex } from "../../src/vision/classifier";
import { FEATURE_CONFIG, mirrorFrame } from "../../src/vision/features";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const RSL = path.join(ROOT, "public/signs/rsl");
export const STREAM = path.join(import.meta.dirname, "cache/stream");

// experiments: FEAT=frame=yaw,posNorm=arm,sideOrigin=1
for (const kv of (process.env.FEAT ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  (FEATURE_CONFIG as unknown as Record<string, unknown>)[k] = k === "sideOrigin" ? v === "1" : v;
}

export function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args.set(m[1], m[2] ?? "1");
  }
  return args;
}

export interface Item { id: string; gloss: string; lesson: number; t0: number; t1: number; clip?: string }
export const manifest = JSON.parse(readFileSync(path.join(RSL, "manifest.json"), "utf8")) as { items: Item[] };
export const phrasebook = JSON.parse(readFileSync(path.join(ROOT, "server/data/phrasebook.json"), "utf8")) as { items: { text: string; gloss: string[] }[] };

const index = JSON.parse(readFileSync(path.join(RSL, "templates.json"), "utf8")) as TemplateIndex;
const bin = readFileSync(path.join(RSL, "templates.bin"));
export const fullBank = decodeTemplateBank(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const lessonOfId = new Map(manifest.items.map((i) => [i.id, i.lesson]));

/** The bank without the templates of one lesson (leave-lesson-out). */
export function bankWithout(lesson: number): TemplateBank {
  const keep: number[] = [];
  for (let r = 0; r < fullBank.rows.length; r++) if (lessonOfId.get(fullBank.ids![r]) !== lesson) keep.push(r);
  const size = fullBank.n * fullBank.dims;
  const data = new Float32Array(keep.length * size);
  keep.forEach((r, i) => data.set(fullBank.data.subarray(r * size, (r + 1) * size), i * size));
  return { ...fullBank, rows: keep.map((r) => fullBank.rows[r]), ids: keep.map((r) => fullBank.ids![r]), data };
}

export interface StreamFrame extends MocapFrame { vis: number[] | null }
export interface Stream { fps: number; width: number; height: number; frames: StreamFrame[] }

export function loadStream(lesson: number): Stream {
  return JSON.parse(readFileSync(path.join(STREAM, `l${lesson.toString().padStart(2, "0")}.json`), "utf8")) as Stream;
}

// ───────────────────────── perturbations ─────────────────────────
let seed = 7;
export function resetSeed(s = 7): void { seed = s; }
export function rnd(): number {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const gauss = (s: number) => s * Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

export function lerpFrame(a: StreamFrame, b: StreamFrame, u: number, t: number): StreamFrame {
  const lerp = (p: Vec3[] | null, q: Vec3[] | null): Vec3[] | null =>
    !p || !q ? (u < 0.5 ? p : q) : p.map((v, k) => [v[0] + (q[k][0] - v[0]) * u, v[1] + (q[k][1] - v[1]) * u, v[2] + (q[k][2] - v[2]) * u] as Vec3);
  return { t, pose: lerp(a.pose, b.pose), leftHand: lerp(a.leftHand, b.leftHand), rightHand: lerp(a.rightHand, b.rightHand), face: null, vis: u < 0.5 ? a.vis : b.vis };
}

/**
 * Landmark-space perturbations (a different signer / camera), applied before the pipeline:
 *   mirror    left-handed signer (x → −x, hands swapped)
 *   fpsN      frames dropped to N fps
 *   noiseN    Gaussian noise N mm on pose, N/2 mm on hands
 *   scaleS    whole body × S
 *   armS      forearm + upper-arm length × S (different proportions)
 *   speedS    signing S× faster (S < 1 slower); returns timeScale = 1/S for ground-truth times
 *   dropP     each hand lost with probability P per frame
 *   tiltD     camera pitched D° (rotation about x);  yawD  body turned D° (about y)
 */
export function applyPerturbations(frames: StreamFrame[], fps: number, perturb: string[]): { frames: StreamFrame[]; timeScale: number } {
  let timeScale = 1;
  for (const p of perturb) {
    const m = /^([a-z]+)([\d.]*)$/.exec(p);
    if (!m) throw new Error(`bad perturbation ${p}`);
    const kind = m[1], v = Number(m[2]);
    if (kind === "mirror") frames = frames.map((f) => ({ ...mirrorFrame(f), vis: f.vis ? mirrorVis(f.vis) : null }));
    else if (kind === "fps") {
      const step = Math.max(1, Math.round(fps / v));
      frames = frames.filter((_, i) => i % step === 0);
    } else if (kind === "noise") {
      const sp = v / 1000, sh = v / 2000;
      frames = frames.map((f) => ({ ...f, pose: jitter(f.pose, sp), leftHand: jitter(f.leftHand, sh), rightHand: jitter(f.rightHand, sh) }));
    } else if (kind === "scale") {
      frames = frames.map((f) => ({ ...f, pose: scale(f.pose, v), leftHand: scale(f.leftHand, v), rightHand: scale(f.rightHand, v) }));
    } else if (kind === "arm") {
      frames = frames.map((f) => ({ ...f, pose: armScale(f.pose, v) }));
    } else if (kind === "speed") {
      const dt = 1000 / fps;
      const T = frames[frames.length - 1].t / v;
      const out: StreamFrame[] = [];
      let j = 0;
      for (let t = 0; t <= T; t += dt) {
        const src = t * v;
        while (j < frames.length - 2 && frames[j + 1].t < src) j++;
        const a = frames[j], b = frames[Math.min(j + 1, frames.length - 1)];
        const u = b.t > a.t ? Math.min(1, Math.max(0, (src - a.t) / (b.t - a.t))) : 0;
        out.push(lerpFrame(a, b, u, t));
      }
      frames = out;
      timeScale *= 1 / v;
    } else if (kind === "drop") {
      frames = frames.map((f) => ({ ...f, leftHand: rnd() < v ? null : f.leftHand, rightHand: rnd() < v ? null : f.rightHand }));
    } else if (kind === "tilt" || kind === "yaw") {
      const th = (v * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
      const rot = (q: Vec3): Vec3 => kind === "tilt" ? [q[0], q[1] * c - q[2] * s, q[1] * s + q[2] * c] : [q[0] * c + q[2] * s, q[1], -q[0] * s + q[2] * c];
      const R = (pts: Vec3[] | null) => (pts ? pts.map(rot) : null);
      frames = frames.map((f) => ({ ...f, pose: R(f.pose), leftHand: R(f.leftHand), rightHand: R(f.rightHand) }));
    } else throw new Error(`unknown perturbation ${kind}`);
  }
  return { frames, timeScale };
}
const POSE_PAIRS: [number, number][] = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
function mirrorVis(v: number[]): number[] {
  const o = v.slice();
  for (const [a, b] of POSE_PAIRS) { o[a] = v[b]; o[b] = v[a]; }
  return o;
}
const jitter = (pts: Vec3[] | null, s: number) => (pts ? pts.map((p) => [p[0] + gauss(s), p[1] + gauss(s), p[2] + gauss(s)] as Vec3) : null);
const scale = (pts: Vec3[] | null, s: number) => (pts ? pts.map((p) => [p[0] * s, p[1] * s, p[2] * s] as Vec3) : null);
function armScale(pose: Vec3[] | null, s: number): Vec3[] | null {
  if (!pose) return null;
  const out = pose.map((p) => p.slice() as Vec3);
  for (const [sh, el, wr, extra] of [[11, 13, 15, [17, 19, 21]], [12, 14, 16, [18, 20, 22]]] as [number, number, number, number[]][]) {
    const S = pose[sh], E = pose[el], W = pose[wr];
    const E2: Vec3 = [S[0] + (E[0] - S[0]) * s, S[1] + (E[1] - S[1]) * s, S[2] + (E[2] - S[2]) * s];
    const W2: Vec3 = [E2[0] + (W[0] - E[0]) * s, E2[1] + (W[1] - E[1]) * s, E2[2] + (W[2] - E[2]) * s];
    out[el] = E2; out[wr] = W2;
    for (const k of extra) out[k] = [W2[0] + (pose[k][0] - W[0]), W2[1] + (pose[k][1] - W[1]), W2[2] + (pose[k][2] - W[2])];
  }
  return out;
}

// ───────────────────────── stats ─────────────────────────
export const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
export const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };
export const mean = (xs: number[]) => { const s = xs.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN; };
export const q = (xs: number[], p: number) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };

/** Levenshtein distance between gloss sequences */
export function editDistance(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  const d = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) d[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n];
}
