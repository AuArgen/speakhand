// Глосс тизмеги → аватар ойното турган элементтер.
// Асинхрондуу: китепкана жесттеринин клиптери керек болгондо гана жүктөлөт (resolveClip).
// Тамгалоо (#СӨЗ): видеосабактагы чыныгы дактиль тамгалары (#А, #Б, …) бар болсо — алардан бир
// MocapClip куралат; бир тамга да жок болсо (мис. кыргызча Ң, Ө, Ү) — процедуралык fingerspellClip.
import type { MocapClip, MocapFrame, SignEntry, Vec3 } from "./types";
import { fingerspellClip, type PlayItem } from "../avatar";
import { resolveClip } from "../data/library";

export interface SequenceItem extends PlayItem {
  /** "sign" — сөздүктө бар; "fingerspell" — тамгалап; "missing" — көрсөтүүгө клип жок */
  type: "sign" | "fingerspell" | "missing";
}

export async function buildSequence(gloss: string[], signs: SignEntry[]): Promise<SequenceItem[]> {
  const byGloss = new Map(signs.map((s) => [s.gloss, s]));
  const letters = letterIndex(signs);
  return Promise.all(
    gloss.map(async (g): Promise<SequenceItem> => {
      if (g.startsWith("#")) return spell(g.slice(1), letters);
      const entry = byGloss.get(g);
      if (entry) {
        const clip = await resolveClip(entry);
        if (clip) return { gloss: g, clip, type: "sign" };
      }
      return spell(g, letters);
    }),
  );
}

async function spell(word: string, letters: Map<string, SignEntry>): Promise<SequenceItem> {
  const real = await realFingerspell(word, letters).catch(() => null);
  if (real) return { gloss: word, clip: real, type: "fingerspell" };
  const clip = fingerspellClip(word);
  return { gloss: word, clip, type: clip ? "fingerspell" : "missing" };
}

// ───────────────────────── чыныгы дактиль ─────────────────────────

/** Кыймылы бар тамгалар (РЖЯ): узунураак бөлүгү алынат */
const MOVING = new Set(["Ё", "Й", "Д", "З", "Ц", "Щ", "Ъ"]);
const HOLD_S = 0.38;
const MOVE_S = 0.75;
const BLEND_FRAMES = 3;

/** "#А" сыяктуу бир тамгалуу глосстор + алардын бир тамгалуу сөз формалары (мис. "#Ь" → ь, ъ). */
export function letterIndex(signs: SignEntry[]): Map<string, SignEntry> {
  const out = new Map<string, SignEntry>();
  for (const s of signs) {
    const m = /^#(.)$/u.exec(s.gloss);
    if (!m) continue;
    out.set(m[1].toLocaleUpperCase("ru"), s);
  }
  for (const s of signs) {
    if (!/^#.$/u.test(s.gloss)) continue;
    for (const a of s.aliases) {
      const k = a.toLocaleUpperCase("ru");
      if ([...k].length === 1 && !out.has(k)) out.set(k, s);
    }
  }
  return out;
}

/** Сөздүн бардык тамгалары китепканада болсо — чыныгы тамгалардан бир клип; болбосо null. */
export async function realFingerspell(word: string, letters: Map<string, SignEntry>): Promise<MocapClip | null> {
  const chars = [...word.toLocaleUpperCase("ru")].filter((c) => c.trim() && c !== "-");
  if (!chars.length || chars.some((c) => !letters.has(c))) return null;
  const clips = await Promise.all(chars.map((c) => resolveClip(letters.get(c))));
  if (clips.some((c) => !c || c.kind !== "mocap")) return null;
  const parts = (clips as MocapClip[]).map((c, i) => holdSegment(c, MOVING.has(chars[i]) ? MOVE_S : HOLD_S));
  if (parts.some((p) => !p.length)) return null;
  const fps = (clips[0] as MocapClip).fps || 20;
  const frames: MocapFrame[] = [];
  for (const part of parts) {
    const prev = frames.at(-1);
    if (prev) for (let k = 1; k <= BLEND_FRAMES; k++) frames.push(lerpFrame(prev, part[0], k / (BLEND_FRAMES + 1)));
    frames.push(...part);
  }
  return { kind: "mocap", fps, frames: frames.map((f, i) => ({ ...f, t: Math.round((i * 10000) / fps) / 10 })) };
}

/** Тамга клибинин эң туруктуу (кол формасы кармалып турган) бөлүгү, узундугу ~seconds. */
function holdSegment(c: MocapClip, seconds: number): MocapFrame[] {
  const f = c.frames;
  const right = f.filter((x) => x.rightHand).length >= f.filter((x) => x.leftHand).length;
  const hand = (x: MocapFrame) => (right ? x.rightHand : x.leftHand);
  const wrist = (x: MocapFrame) => x.pose?.[right ? 16 : 15] ?? null;
  const W = Math.max(2, Math.min(f.length, Math.round(seconds * (c.fps || 20))));
  // m[i] — i-1 → i кадрдагы кыймыл (кол формасы + билек); кол жок болсо — чоң айып
  const m = new Float64Array(f.length);
  for (let i = 1; i < f.length; i++) {
    const a = hand(f[i - 1]), b = hand(f[i]);
    if (!a || !b) { m[i] = 1; continue; }
    let s = 0;
    for (let k = 0; k < 21; k++) s += dist(a[k], b[k]);
    const wa = wrist(f[i - 1]), wb = wrist(f[i]);
    m[i] = s / 21 + (wa && wb ? dist(wa, wb) : 0);
  }
  let best = -1, bestCost = Infinity;
  const first = Math.min(2, Math.max(0, f.length - W)); // алгачкы кадрлар — мурунку тамгадан өтүү
  for (let a = first; a + W <= f.length; a++) {
    if (!hand(f[a])) continue;
    let cost = 0;
    for (let i = a + 1; i < a + W; i++) cost += m[i];
    if (cost < bestCost) { bestCost = cost; best = a; }
  }
  if (best < 0) return [];
  return f.slice(best, best + W);
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lerpPts(p: Vec3[] | null, q: Vec3[] | null, u: number): Vec3[] | null {
  if (!p || !q) return u < 0.5 ? p : q;
  return p.map((v, i) => [v[0] + (q[i][0] - v[0]) * u, v[1] + (q[i][1] - v[1]) * u, v[2] + (q[i][2] - v[2]) * u] as Vec3);
}

function lerpFrame(a: MocapFrame, b: MocapFrame, u: number): MocapFrame {
  let face: Record<string, number> | null = u < 0.5 ? a.face : b.face;
  if (a.face && b.face) {
    face = {};
    for (const k of Object.keys(a.face)) face[k] = a.face[k] + ((b.face[k] ?? a.face[k]) - a.face[k]) * u;
  }
  return {
    t: 0,
    pose: lerpPts(a.pose, b.pose, u),
    leftHand: lerpPts(a.leftHand, b.leftHand, u),
    rightHand: lerpPts(a.rightHand, b.rightHand, u),
    face,
  };
}
