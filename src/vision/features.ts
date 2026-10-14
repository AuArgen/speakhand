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

// ───────────────────────── бир кадрдын белгилери ─────────────────────────

interface BodyFrame {
  /** ийиндердин ортосу */
  cx: number; cy: number; cz: number;
  /** 1 / ийиндин туурасы */
  inv: number;
  /** ийин сызыгынын y огунун айланасындагы буруусу (cos, sin) */
  cos: number; sin: number;
}

function bodyFrame(pose: Vec3[] | null): BodyFrame | null {
  if (!pose || pose.length < 25) return null;
  const l = pose[POSE.L_SHOULDER], r = pose[POSE.R_SHOULDER];
  const dx = l[0] - r[0], dy = l[1] - r[1], dz = l[2] - r[2];
  const w = Math.hypot(dx, dy, dz);
  if (!(w > 1e-4)) return null;
  // +x = адамдын сол тарабы, демек l - r ≈ +x. Анын xz-проекциясын +x огуна буруйбуз.
  const h = Math.hypot(dx, dz) || 1;
  return {
    cx: (l[0] + r[0]) / 2, cy: (l[1] + r[1]) / 2, cz: (l[2] + r[2]) / 2,
    inv: 1 / w,
    cos: dx / h, sin: dz / h,
  };
}

/** Чекитти дененин системасына которот (ийин ортосу = 0, ийин туурасы = 1). */
function toBody(b: BodyFrame, p: Vec3, out: Float32Array, o: number, w: number): void {
  const x = (p[0] - b.cx) * b.inv, y = (p[1] - b.cy) * b.inv, z = (p[2] - b.cz) * b.inv;
  // y огунун айланасында -θ бурулуш: θ = atan2(sin, cos) (x→z)
  out[o] = (x * b.cos + z * b.sin) * w;
  out[o + 1] = y * w;
  out[o + 2] = (-x * b.sin + z * b.cos) * w;
}

function writeHand(
  out: Float32Array, o: number, hand: Vec3[] | null, body: BodyFrame | null,
  pose: Vec3[] | null, wristIdx: number, elbowIdx: number,
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
        out[k] = x * body.cos + z * body.sin;
        out[k + 1] = y;
        out[k + 2] = -x * body.sin + z * body.cos;
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
    toBody(body, pose[wristIdx], out, po, W.position);
    toBody(body, pose[elbowIdx], out, po + 3, W.elbow);
  } else {
    out.fill(0, po, po + 6);
  }
}

/** Бир кадрдын белги вектору (узундугу FEATURE_DIM). */
export function frameFeatures(f: MocapFrame, out = new Float32Array(FEATURE_DIM), offset = 0): Float32Array {
  const body = bodyFrame(f.pose);
  writeHand(out, offset, f.leftHand, body, f.pose, POSE.L_WRIST, POSE.L_ELBOW);
  writeHand(out, offset + HAND_DIM, f.rightHand, body, f.pose, POSE.R_WRIST, POSE.R_ELBOW);
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
  const m = src.length;
  const D = FEATURE_DIM;
  const raw = new Float32Array(m * D);
  for (let i = 0; i < m; i++) frameFeatures(src[i], raw, i * D);
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
