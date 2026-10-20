// Жестти классификациялоо үчүн белгилерди (features) чыгаруу.
//
// Ар бир кадр → туруктуу узундуктагы вектор (FEATURE_DIM). Вектор адамдын бою, кадрдагы орду
// жана камерага чейинки аралыгы өзгөргөндө дээрлик өзгөрбөйт:
//   • колдун формасы: 21 чекит билекке (0) салыштырмалуу, алакандын өлчөмүнө (0→9) бөлүнгөн;
//   • колдун орду: pose'дун билеги ийиндердин ортосуна салыштырмалуу, ийиндин туурасына бөлүнгөн,
//     дене камерага бир аз бурулуп турса — ийин сызыгы боюнча y огунун айланасында түздөлөт;
//   • чыканак — ошол эле системада;
//   • кол көрүнбөсө — нөлдөр + "бар/жок" белгиси.
// Убакыт боюнча: кыска тешиктер (кол бир нече кадрга жоголсо) интерполяцияланат, андан кийин
// ырааттуулук N=32 кадрга сызыктуу интерполяция менен кайра бөлүнөт.

import type { MocapClip, MocapFrame, Vec3 } from "../lib/types";

/** Pose индекстери (MediaPipe) */
export const POSE = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
} as const;

/** Pose'дун сол/оң жуп чекиттери (күзгү үчүн) */
const POSE_MIRROR_PAIRS: [number, number][] = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20],
  [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32],
];

export const RESAMPLE_N = 32;

/** Белгилердин версиясы — өзгөргөндө templates.bin кайра түзүлүшү керек (templates.ts текшерет) */
export const FEATURE_VERSION = 2;

/**
 * Белгилердин варианттары (эксперимент үчүн; tools/rsl_import/livereplay.ts FEAT= менен өзгөртөт).
 *   frame: "yaw" — ийин сызыгы боюнча y огунун айланасында гана түздөө (эски);
 *          "full" — ийин сызыгы + дене огу (ийин→жамбаш): камеранын ийилишине (pitch) да туруктуу.
 *   posNorm: билек/чыканак ордунун өлчөм бирдиги — "shoulder" (ийин туурасы), "arm" (колдун узундугу,
 *          клип боюнча медиана), "mix" (экөөнүн орточосу).
 *   sideOrigin: билек орду ошол эле тараптын ийинине салыштырмалуу (true) же ийиндердин ортосуна (false).
 */
export const FEATURE_CONFIG = {
  frame: "full" as "yaw" | "full",
  posNorm: "mix" as "shoulder" | "arm" | "mix",
  sideOrigin: false,
};

/** Белги топторунун салмактары (DTW аралыгындагы салымы) */
export const FEATURE_WEIGHTS = {
  presence: 0.6,
  shape: 0.32,
  position: 1.6,
  elbow: 0.6,
};

const SHAPE_DIMS = 20 * 3; // билектен башка 20 чекит
/** Бир колго: presence(1) + shape(60) + position(3) + elbow(3) */
export const HAND_DIM = 1 + SHAPE_DIMS + 3 + 3;
/** Бир кадрдын белги вектору: сол кол + оң кол */
export const FEATURE_DIM = HAND_DIM * 2;

export interface FeatureOptions {
  /** Сол колдуу адам үчүн: кадрды күзгүдөй чагылдырып, андан кийин белгилерди эсептейт */
  mirror?: boolean;
  /** Кайра бөлүүдөгү кадрлардын саны (демейки 32) */
  n?: number;
  /** Кол ушунча кадрдан аз жоголсо, тешик интерполяцияланат (демейки 6) */
  maxGap?: number;
  /**
   * Себептүү (causal) EMA жылмалоо: жаңы = мурунку × smooth + учурдагы × (1 − smooth), 0 — өчүк.
   * Түз эфирдеги ызы-чуулуу кадрларды китепкананын жылмаланган клиптерине жакындатат.
   */
  smooth?: number;
  /** Өлчөм бирдиги (м), клип боюнча эсептөөнүн ордуна (сүйлөмдүн бөлүктөрү үчүн бирдей болсун) */
  scale?: number;
}

// ───────────────────────── күзгү ─────────────────────────

function mirrorVec(v: Vec3): Vec3 {
  return [-v[0], v[1], v[2]];
}

const FACE_LR = /(Left|Right)$/;

/** Кадрды күзгүдөй чагылдырат: x → -x, сол↔оң колдор жана pose чекиттери алмашат. */
export function mirrorFrame(f: MocapFrame): MocapFrame {
  let pose: Vec3[] | null = null;
  if (f.pose) {
    pose = f.pose.map(mirrorVec);
    for (const [a, b] of POSE_MIRROR_PAIRS) {
      if (a < pose.length && b < pose.length) {
        const tmp = pose[a]; pose[a] = pose[b]; pose[b] = tmp;
      }
    }
  }
  let face: Record<string, number> | null = null;
  if (f.face) {
    face = {};
    for (const [k, v] of Object.entries(f.face)) {
      const m = FACE_LR.exec(k);
      const key = m ? k.slice(0, -m[1].length) + (m[1] === "Left" ? "Right" : "Left") : k;
      face[key] = v;
    }
  }
  return {
    t: f.t,
    pose,
    leftHand: f.rightHand ? f.rightHand.map(mirrorVec) : null,
    rightHand: f.leftHand ? f.leftHand.map(mirrorVec) : null,
    face,
  };
}

export function mirrorClip(c: MocapClip): MocapClip {
  return { kind: "mocap", fps: c.fps, frames: c.frames.map(mirrorFrame) };
}

// ───────────────────────── тешиктерди толтуруу ─────────────────────────

function lerpVecs(a: Vec3[], b: Vec3[], u: number): Vec3[] {
  const out: Vec3[] = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    out[i] = [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u];
  }
  return out;
}

/**
 * Кол же pose бир нече кадрга жоголгон кыска тешиктерди сызыктуу интерполяция менен толтурат.
 * Узун тешиктер (кол чындап түшүрүлгөн) өзгөрүүсүз калат.
 */
export function fillGaps(frames: MocapFrame[], maxGap = 6): MocapFrame[] {
  const out = frames.map((f) => ({ ...f }));
  const keys = ["leftHand", "rightHand", "pose"] as const;
  for (const key of keys) {
    let last = -1;
    for (let i = 0; i < out.length; i++) {
      const cur = out[i][key];
      if (!cur) continue;
      if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
        const a = out[last][key]!, b = cur;
        if (a.length === b.length) {
          const ta = out[last].t, tb = out[i].t;
          for (let j = last + 1; j < i; j++) {
            const u = tb > ta ? (out[j].t - ta) / (tb - ta) : (j - last) / (i - last);
            out[j][key] = lerpVecs(a, b, u);
          }
        }
      }
      last = i;
    }
  }
  return out;
}

/** Себептүү EMA жылмалоо (кадр жок болсо абал кайра башталат). alpha — мурункунун салмагы. */
export function smoothFrames(frames: MocapFrame[], alpha: number): MocapFrame[] {
  if (!(alpha > 0)) return frames;
  const a = Math.min(0.95, alpha);
  const keys = ["leftHand", "rightHand", "pose"] as const;
  const state: Record<(typeof keys)[number], Vec3[] | null> = { leftHand: null, rightHand: null, pose: null };
  return frames.map((f) => {
    const out: MocapFrame = { ...f };
    for (const key of keys) {
      const cur = f[key];
      const prev = state[key];
      if (!cur) { state[key] = null; continue; }
      if (!prev || prev.length !== cur.length) { state[key] = cur; continue; }
      const sm = lerpVecs(cur, prev, a);
      out[key] = sm;
      state[key] = sm;
    }
    return out;
  });
}

// ───────────────────────── бир кадрдын белгилери ─────────────────────────

interface BodyFrame {
  /** ийиндердин ортосу */
  cx: number; cy: number; cz: number;
  /** 1 / өлчөм бирдиги (ийин туурасы же колдун узундугу) */
  inv: number;
  /** ортонормалдуу дене системасы: ex (оңдон солго), ey (өйдө), ez (камерага) */
  ex: Vec3; ey: Vec3; ez: Vec3;
}

const norm3 = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};

/**
 * Дененин системасы. scale — өлчөм бирдиги (м); берилбесе ийин туурасы.
 * frame "yaw": ийин сызыгын xz-тегиздигинде +x огуна буруу (y огу өзгөрбөйт);
 * frame "full": ийин сызыгы = ex, дене огу (жамбаш→ийин) = ey — камера ийилсе да бирдей.
 */
function bodyFrame(pose: Vec3[] | null, scale?: number): BodyFrame | null {
  if (!pose || pose.length < 25) return null;
  const l = pose[POSE.L_SHOULDER], r = pose[POSE.R_SHOULDER];
  const dx = l[0] - r[0], dy = l[1] - r[1], dz = l[2] - r[2];
  const w = Math.hypot(dx, dy, dz);
  if (!(w > 1e-4)) return null;
  const cx = (l[0] + r[0]) / 2, cy = (l[1] + r[1]) / 2, cz = (l[2] + r[2]) / 2;
  let ex: Vec3, ey: Vec3, ez: Vec3;
  if (FEATURE_CONFIG.frame === "yaw") {
    const h = Math.hypot(dx, dz) || 1;
    const c = dx / h, s = dz / h;
    ex = [c, 0, s]; ey = [0, 1, 0]; ez = [-s, 0, c];
  } else {
    ex = norm3([dx, dy, dz]);
    const hx = (pose[POSE.L_HIP][0] + pose[POSE.R_HIP][0]) / 2, hy = (pose[POSE.L_HIP][1] + pose[POSE.R_HIP][1]) / 2, hz = (pose[POSE.L_HIP][2] + pose[POSE.R_HIP][2]) / 2;
    let up: Vec3 = [cx - hx, cy - hy, cz - hz];
    if (!(Math.hypot(up[0], up[1], up[2]) > 0.3 * w)) up = [0, 1, 0];
    const d = up[0] * ex[0] + up[1] * ex[1] + up[2] * ex[2];
    ey = norm3([up[0] - d * ex[0], up[1] - d * ex[1], up[2] - d * ex[2]]);
    ez = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
  }
  return { cx, cy, cz, inv: 1 / (scale ?? w), ex, ey, ez };
}

/** Чекитти дененин системасына которот (ийин ортосу = 0, өлчөм бирдиги = 1). */
function toBody(b: BodyFrame, p: Vec3, out: Float32Array, o: number, w: number, origin?: Vec3): void {
  const x = p[0] - (origin ? origin[0] : b.cx), y = p[1] - (origin ? origin[1] : b.cy), z = p[2] - (origin ? origin[2] : b.cz);
  const k = b.inv * w;
  out[o] = (x * b.ex[0] + y * b.ex[1] + z * b.ex[2]) * k;
  out[o + 1] = (x * b.ey[0] + y * b.ey[1] + z * b.ey[2]) * k;
  out[o + 2] = (x * b.ez[0] + y * b.ez[1] + z * b.ez[2]) * k;
}

/** Колдун узундугу (ийин→чыканак→билек), эки колдун орточосу; pose жок болсо NaN */
function armLength(pose: Vec3[] | null): number {
  if (!pose || pose.length < 25) return NaN;
  const seg = (a: number, b: number) => Math.hypot(pose[a][0] - pose[b][0], pose[a][1] - pose[b][1], pose[a][2] - pose[b][2]);
  return (seg(POSE.L_SHOULDER, POSE.L_ELBOW) + seg(POSE.L_ELBOW, POSE.L_WRIST) + seg(POSE.R_SHOULDER, POSE.R_ELBOW) + seg(POSE.R_ELBOW, POSE.R_WRIST)) / 2;
}
function shoulderWidth(pose: Vec3[] | null): number {
  if (!pose || pose.length < 25) return NaN;
  const l = pose[POSE.L_SHOULDER], r = pose[POSE.R_SHOULDER];
  return Math.hypot(l[0] - r[0], l[1] - r[1], l[2] - r[2]);
}

/**
 * Клип боюнча өлчөм бирдиги (м): FEATURE_CONFIG.posNorm боюнча ийин туурасынын жана/же колдун
 * узундугунун медианасы. Колдун узундугу ийин туурасынын ~1.65 эсеси — 0.6 коэффициенти менен
 * бирдиктер салыштырмалуу болот (салмактар өзгөрбөйт). undefined — кадр сайын ийин туурасы.
 */
export function clipScale(frames: MocapFrame[]): number | undefined {
  const mode = FEATURE_CONFIG.posNorm;
  if (mode === "shoulder") return undefined;
  const sw: number[] = [], al: number[] = [];
  for (const f of frames) {
    const w = shoulderWidth(f.pose), a = armLength(f.pose);
    if (w > 1e-4) sw.push(w);
    if (a > 1e-4) al.push(a);
  }
  if (!sw.length || !al.length) return undefined;
  const med = (xs: number[]) => { xs.sort((p, q) => p - q); return xs[xs.length >> 1]; };
  const w = med(sw), a = 0.6 * med(al);
  return mode === "arm" ? a : 0.5 * (w + a);
}

function writeHand(
  out: Float32Array, o: number, hand: Vec3[] | null, body: BodyFrame | null,
  pose: Vec3[] | null, wristIdx: number, elbowIdx: number, shoulderIdx: number,
): void {
  const W = FEATURE_WEIGHTS;
  if (hand && hand.length >= 21) {
    out[o] = W.presence;
    const w0 = hand[0], m = hand[9];
    const palm = Math.hypot(m[0] - w0[0], m[1] - w0[1], m[2] - w0[2]) || 1;
    const s = W.shape / palm;
    let k = o + 1;
    for (let i = 1; i < 21; i++) {
      const p = hand[i];
      // Колдун багытын да дененин буруусуна карата түздөйбүз
      const x = (p[0] - w0[0]) * s, y = (p[1] - w0[1]) * s, z = (p[2] - w0[2]) * s;
      if (body) {
        out[k] = x * body.ex[0] + y * body.ex[1] + z * body.ex[2];
        out[k + 1] = x * body.ey[0] + y * body.ey[1] + z * body.ey[2];
        out[k + 2] = x * body.ez[0] + y * body.ez[1] + z * body.ez[2];
      } else {
        out[k] = x; out[k + 1] = y; out[k + 2] = z;
      }
      k += 3;
    }
  } else {
    out.fill(0, o, o + 1 + SHAPE_DIMS);
  }
  const po = o + 1 + SHAPE_DIMS;
  if (body && pose && pose.length > wristIdx) {
    const origin = FEATURE_CONFIG.sideOrigin ? pose[shoulderIdx] : undefined;
    toBody(body, pose[wristIdx], out, po, W.position, origin);
    toBody(body, pose[elbowIdx], out, po + 3, W.elbow, origin);
  } else {
    out.fill(0, po, po + 6);
  }
}

/** Бир кадрдын белги вектору (узундугу FEATURE_DIM). scale — клиптин өлчөм бирдиги (clipScale). */
export function frameFeatures(f: MocapFrame, out = new Float32Array(FEATURE_DIM), offset = 0, scale?: number): Float32Array {
  const body = bodyFrame(f.pose, scale);
  writeHand(out, offset, f.leftHand, body, f.pose, POSE.L_WRIST, POSE.L_ELBOW, POSE.L_SHOULDER);
  writeHand(out, offset + HAND_DIM, f.rightHand, body, f.pose, POSE.R_WRIST, POSE.R_ELBOW, POSE.R_SHOULDER);
  return out;
}

// ───────────────────────── ырааттуулук ─────────────────────────

/**
 * Клиптин кадрларын белгилерге айландырып, убакыт боюнча N кадрга кайра бөлөт.
 * Натыйжа: Float32Array, узундугу N * FEATURE_DIM (кадрлар катар жайгашкан).
 * Кадр жок болсо — null.
 */
export function sequenceFeatures(frames: MocapFrame[], opts: FeatureOptions = {}): Float32Array | null {
  const n = opts.n ?? RESAMPLE_N;
  if (!frames.length) return null;
  let src = opts.mirror ? frames.map(mirrorFrame) : frames;
  src = fillGaps(src, opts.maxGap ?? 6);
  if (opts.smooth) src = smoothFrames(src, opts.smooth);
  const m = src.length;
  const D = FEATURE_DIM;
  const raw = new Float32Array(m * D);
  const scale = opts.scale ?? clipScale(src);
  for (let i = 0; i < m; i++) frameFeatures(src[i], raw, i * D, scale);
  return resample(raw, src.map((f) => f.t), n, D);
}

export function clipFeatures(clip: MocapClip, opts: FeatureOptions = {}): Float32Array | null {
  return sequenceFeatures(clip.frames, opts);
}

/**
 * Убакыт боюнча сызыктуу интерполяция: m кадр (убакыттары `times`) → n бирдей аралыктагы кадр.
 * Убакыттар монотондуу эмес болсо, индекс боюнча бөлүнөт.
 */
export function resample(raw: Float32Array, times: number[], n: number, D: number): Float32Array {
  const m = times.length;
  const out = new Float32Array(n * D);
  if (m === 1) {
    for (let i = 0; i < n; i++) out.set(raw.subarray(0, D), i * D);
    return out;
  }
  let monotonic = times[m - 1] > times[0];
  for (let i = 1; i < m && monotonic; i++) if (times[i] < times[i - 1]) monotonic = false;
  const ts = monotonic ? times : times.map((_, i) => i);
  const t0 = ts[0], t1 = ts[m - 1];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    while (j < m - 2 && ts[j + 1] < t) j++;
    const ta = ts[j], tb = ts[j + 1];
    const u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    const a = j * D, b = (j + 1) * D, o = i * D;
    for (let d = 0; d < D; d++) out[o + d] = raw[a + d] + (raw[b + d] - raw[a + d]) * u;
  }
  return out;
}
