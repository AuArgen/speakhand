// Кол формаларынын китепканасы (HandShape → манжалардын абалы).
// Багыттар колдун абстракттуу кадрында берилет: f = манжалар (билек → ортоңку муун),
// s = сөөмөй/бармак жагы, n = алакан караган жак. Ошондуктан бир эле форма эки колго тең
// (күзгүдөй) иштейт жана ар кандай риг үчүн масштабдан көз карандысыз.
//
// Бармак: "учу кайда болушу керек" (метр, колдун кадрында) + ийилүү тарабы менен сүрөттөлөт,
// андан 3 сегменттин багыты аналитикалык IK менен эсептелет — ошондо O/F/C формаларында
// бармактын учу чын эле манжалардын учуна тиет.
import type { HandShape } from "../lib/types";

export type V3 = [number, number, number];
/** [MCP бүгүлүү, PIP, DIP, жайылуу (рад, + = s жакка)] */
export type FingerCurl = [number, number, number, number];

export interface HandPose {
  Index: FingerCurl;
  Middle: FingerCurl;
  Ring: FingerCurl;
  Pinky: FingerCurl;
  /** Бармактын 3 сегментинин багыты (f, s, n) */
  thumb: [V3, V3, V3];
}

export const CURLED_FINGERS = ["Index", "Middle", "Ring", "Pinky"] as const;
export type CurledFinger = (typeof CURLED_FINGERS)[number];

/** Бармактын CMC муунунун орду жана фалангалардын узундугу (метр, колдун кадрында) — rig.ts менен дал келет */
export const THUMB_CMC: V3 = [0.022, 0.024, 0.01];
export const THUMB_LENS: V3 = [0.036, 0.028, 0.023];

export interface FingerGeometry {
  /** Биринчи муундун (MCP / бармакта CMC) орду колдун кадрында (f, s, n), метр */
  base: V3;
  /** Үч фаланганын узундугу */
  lens: V3;
}

/** Колдун геометриясы (колдун кадрында) — ар бир риг үчүн тынч позадан өлчөнөт */
export interface HandGeometry {
  fingers: Record<CurledFinger, FingerGeometry>;
  thumb: FingerGeometry;
  /** Билек → ортоңку манжанын MCP муунуна чейинки аралык (алакан узундугу) */
  palm: number;
}

/** Калган манжалардын негизи жана узундуктары (rig.ts FINGER_SPECS менен дал келет) — текшерүү/эсептөө үчүн */
export const FINGER_GEOMETRY: Record<CurledFinger, FingerGeometry> = {
  Index: { base: [0.092, 0.0275, 0], lens: [0.045, 0.027, 0.021] },
  Middle: { base: [0.096, 0.0065, 0], lens: [0.049, 0.03, 0.023] },
  Ring: { base: [0.092, -0.0135, 0], lens: [0.046, 0.028, 0.021] },
  Pinky: { base: [0.084, -0.032, 0], lens: [0.036, 0.022, 0.019] },
};

/** Процедуралык колдун геометриясы — HANDSHAPES ушул геометрияга карата аныкталган */
export const PROCEDURAL_HAND_GEOMETRY: HandGeometry = {
  fingers: FINGER_GEOMETRY,
  thumb: { base: THUMB_CMC, lens: THUMB_LENS },
  palm: FINGER_GEOMETRY.Middle.base[0],
};

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
function norm(a: V3): V3 {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Бармактын учун `tip`ке жеткирген 3 сегменттин багыты. `pole` — чынжыр кайсы тарапка
 * дөңсөйөт (MCP жана IP муундары CMC→tip сызыгынын ушул тарабына чыгат), `ipBend` — IP муунунун
 * бүгүлүүсү (рад). Жетпесе — чынжыр максималдуу созулат.
 */
export function thumbTo(tip: V3, pole: V3, ipBend = 0.25, geom: FingerGeometry = PROCEDURAL_HAND_GEOMETRY.thumb): [V3, V3, V3] {
  const [L1, L2, L3] = geom.lens;
  const THUMB_CMC = geom.base;
  const L23 = Math.sqrt(L2 * L2 + L3 * L3 + 2 * L2 * L3 * Math.cos(ipBend));
  const d = sub(tip, THUMB_CMC);
  let dist = len(d);
  const u = dist > 1e-6 ? scl(d, 1 / dist) : ([1, 0, 0] as V3);
  dist = Math.min(Math.max(dist, Math.abs(L1 - L23) + 1e-4), (L1 + L23) * 0.999);
  const x = (L1 * L1 - L23 * L23 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, L1 * L1 - x * x));
  let p = sub(pole, scl(u, dot(pole, u)));
  if (len(p) < 1e-6) p = [0, 1, 0];
  p = norm(p);
  const mcp = add(add(THUMB_CMC, scl(u, x)), scl(p, h));
  const tipClamped = add(THUMB_CMC, scl(u, dist));
  const e = sub(tipClamped, mcp);
  const eLen = len(e) || 1e-6;
  const eu = scl(e, 1 / eLen);
  const x2 = (L2 * L2 - L3 * L3 + eLen * eLen) / (2 * eLen);
  const h2 = Math.sqrt(Math.max(0, L2 * L2 - x2 * x2));
  let p2 = sub(pole, scl(eu, dot(pole, eu)));
  if (len(p2) < 1e-6) p2 = p;
  p2 = norm(p2);
  const ip = add(add(mcp, scl(eu, x2)), scl(p2, h2));
  return [norm(sub(mcp, THUMB_CMC)), norm(sub(ip, mcp)), norm(sub(tipClamped, ip))];
}

/** Манжанын муундарынын орду (MCP, PIP, DIP, учу) колдун кадрында — текшерүү жана бармакты тууралоо үчүн */
export function fingerJoints(f: CurledFinger, c: FingerCurl, geom: FingerGeometry = FINGER_GEOMETRY[f]): [V3, V3, V3, V3] {
  const { base, lens } = geom;
  const dirs = fingerSegmentDirs(c);
  const pts: V3[] = [base];
  let p = base;
  for (let k = 0; k < 3; k++) {
    p = add(p, scl(dirs[k], lens[k]));
    pts.push(p);
  }
  return pts as [V3, V3, V3, V3];
}

/** Бармактын муундарынын орду (CMC, MCP, IP, учу) */
export function thumbJoints(dirs: [V3, V3, V3], geom: FingerGeometry = PROCEDURAL_HAND_GEOMETRY.thumb): [V3, V3, V3, V3] {
  const pts: V3[] = [geom.base];
  let p = geom.base;
  for (let k = 0; k < 3; k++) {
    p = add(p, scl(dirs[k], geom.lens[k]));
    pts.push(p);
  }
  return pts as [V3, V3, V3, V3];
}

/**
 * Бармакты башка геометриядагы колго которуу. HANDSHAPES процедуралык колго карата аныкталган;
 * чыныгы ригде алакан, манжалар жана бармак узундуктары башка. Бармактын учунун максаттуу орду
 * алакан узундугуна жараша масштабдалат, ал эми уч кайсы бир манжанын учуна тийсе (O, pinch…),
 * максат ошол манжанын ушул ригдеги чыныгы учуна байланат — андан кийин бармак ушул ригдин
 * узундуктары менен кайра IK аркылуу чечилет.
 */
export function retargetThumb(pose: HandPose, geom: HandGeometry): [V3, V3, V3] {
  const proc = PROCEDURAL_HAND_GEOMETRY;
  const pj = thumbJoints(pose.thumb, proc.thumb);
  const tipP = pj[3];
  // Ийилүү тарабы: MCP/IP муундарынын CMC→уч сызыгынан четтөөсү
  const u = norm(sub(tipP, pj[0]));
  const perp = (p: V3): V3 => {
    const d = sub(p, pj[0]);
    return sub(d, scl(u, dot(d, u)));
  };
  let pole = perp(pj[1]);
  const ipOff = perp(pj[2]);
  if (len(ipOff) > len(pole)) pole = ipOff;
  if (len(pole) < 1e-4) pole = [0, 1, -0.5];
  const ipBend = Math.acos(Math.max(-1, Math.min(1, dot(pose.thumb[1], pose.thumb[2]))));
  const k = geom.palm / proc.palm;
  let tip: V3 = scl(tipP, k);
  // Тийүү: уч манжанын учуна жакын болсо — ушул ригдин манжа учуна байлайбыз
  let best: { f: CurledFinger; d: number; off: V3 } | null = null;
  for (const f of CURLED_FINGERS) {
    const procTip = fingerJoints(f, pose[f], proc.fingers[f])[3];
    const off = sub(tipP, procTip);
    const d = len(off);
    if (d < 0.03 && (!best || d < best.d)) best = { f, d, off };
  }
  if (best) {
    const rigTip = fingerJoints(best.f, pose[best.f], geom.fingers[best.f])[3];
    tip = add(rigTip, scl(best.off, k));
  }
  return thumbTo(tip, pole, ipBend, geom.thumb);
}

/**
 * Манжанын учуна (алакан жагындагы "жумшак" бөлүгүнө) бармактын учун тийгизүү үчүн бармактын
 * учунун орду: манжанын учунан пад нормалы боюнча `gap` аралыкта (эки капсуланын радиусу).
 */
function padContact(f: CurledFinger, c: FingerCurl, gap = 0.016): V3 {
  const j = fingerJoints(f, c);
  const phi = c[0] + c[1] + c[2];
  // Манжа (cos φ, ·, sin φ) багытында; алакан жагындагы нормал = (−sin φ, ·, cos φ)
  const n: V3 = [-Math.sin(phi) * Math.cos(c[3]), -Math.sin(phi) * Math.sin(c[3]), Math.cos(phi)];
  return add(j[3], scl(norm(n), gap));
}

const FIST: FingerCurl = [1.45, 1.65, 0.9, 0];
const STRAIGHT: FingerCurl = [0.02, 0.03, 0.02, 0];
const fist = (splay = 0, k = 1): FingerCurl => [1.45 * k + 0.05, 1.65 * k + 0.03, 0.9 * k, splay];

// Бармактын даяр абалдары
const T = {
  /** Бош, алакандан бир аз сыртта */
  relaxed: thumbTo([0.088, 0.062, 0.042], [0, 1, -0.6], 0.2),
  /** Сөөмөйдүн жанында, алакан тегиздигинде */
  alongside: thumbTo([0.1, 0.052, 0.012], [0, 1, -0.7], 0.08),
  /** Жайылган (беш) */
  spread: thumbTo([0.058, 0.102, 0.0], [-0.3, 0.3, -1], 0.12),
  /** Капталга чыгарылган (Y, L) */
  out: thumbTo([0.03, 0.104, -0.008], [-0.5, 0, -1], 0.08),
  /** Өйдө (баш бармак "жакшы") */
  up: thumbTo([0.04, 0.106, -0.004], [-0.3, 0.2, -1], 0.1),
  /** Муштум: MCP алакандын радиалдык четинде көтөрүлүп, учу ортоңку манжанын ортоңку фалангасына жатат */
  across: thumbTo([0.072, 0.02, 0.064], [-0.1, 1, 0.15], 0.52),
  /** Көрсөтүү/V: бүгүлгөн ортоңку манжанын үстүндө (сөөмөй түз) */
  acrossLow: thumbTo([0.074, 0.006, 0.068], [-0.1, 1, 0.15], 0.5),
  /** C: манжаларга каршы, ийилген */
  c: thumbTo([0.092, 0.034, 0.055], [0, 1, -0.5], 0.3),
};

const O_INDEX: FingerCurl = [0.85, 1.3, 0.7, -0.02];
const O_MIDDLE: FingerCurl = [0.8, 1.4, 0.75, 0.12];
const PINCH_INDEX: FingerCurl = [1.0, 1.1, 0.7, 0.0];

export const HANDSHAPES: Record<HandShape, HandPose> = {
  rest: {
    Index: [0.22, 0.32, 0.16, 0.05],
    Middle: [0.3, 0.4, 0.2, 0],
    Ring: [0.36, 0.46, 0.22, -0.05],
    Pinky: [0.42, 0.5, 0.25, -0.12],
    thumb: T.relaxed,
  },
  flat: {
    Index: [0.03, 0.03, 0.02, 0.01],
    Middle: [0.03, 0.03, 0.02, 0],
    Ring: [0.03, 0.03, 0.02, -0.01],
    Pinky: [0.04, 0.03, 0.02, -0.04],
    thumb: T.alongside,
  },
  five: {
    Index: [0.0, 0.03, 0.02, 0.2],
    Middle: [0.0, 0.03, 0.02, 0.03],
    Ring: [0.02, 0.03, 0.02, -0.15],
    Pinky: [0.04, 0.04, 0.02, -0.33],
    thumb: T.spread,
  },
  fist: {
    Index: [...FIST] as FingerCurl,
    Middle: [1.5, 1.68, 0.9, 0],
    Ring: [1.52, 1.68, 0.9, 0],
    Pinky: [1.5, 1.65, 0.9, -0.03],
    thumb: T.across,
  },
  point: {
    Index: [...STRAIGHT] as FingerCurl,
    Middle: [1.5, 1.68, 0.9, 0],
    Ring: [1.52, 1.68, 0.9, 0],
    Pinky: [1.5, 1.65, 0.9, -0.03],
    thumb: T.acrossLow,
  },
  v: {
    Index: [0.0, 0.03, 0.02, 0.16],
    Middle: [0.0, 0.03, 0.02, -0.12],
    Ring: [1.5, 1.68, 0.9, 0],
    Pinky: [1.5, 1.65, 0.9, -0.03],
    thumb: T.acrossLow,
  },
  thumb: {
    Index: fist(0.0),
    Middle: fist(0.0, 1.02),
    Ring: fist(0.0, 1.03),
    Pinky: fist(-0.03, 1.02),
    thumb: T.up,
  },
  y: {
    Index: [1.45, 1.65, 0.9, 0],
    Middle: [1.5, 1.68, 0.9, 0],
    Ring: [1.52, 1.68, 0.9, 0],
    Pinky: [0.0, 0.03, 0.02, -0.32],
    thumb: T.out,
  },
  o: {
    Index: O_INDEX,
    Middle: O_MIDDLE,
    Ring: [0.95, 1.4, 0.8, 0.2],
    Pinky: [1.05, 1.45, 0.85, 0.3],
    thumb: thumbTo(padContact("Index", O_INDEX), [0, 1, -0.5], 0.35),
  },
  c: {
    Index: [0.45, 0.65, 0.3, 0.0],
    Middle: [0.45, 0.65, 0.3, 0],
    Ring: [0.47, 0.65, 0.3, -0.02],
    Pinky: [0.5, 0.65, 0.3, -0.05],
    thumb: T.c,
  },
  l: {
    Index: [...STRAIGHT] as FingerCurl,
    Middle: [1.5, 1.68, 0.9, 0],
    Ring: [1.52, 1.68, 0.9, 0],
    Pinky: [1.5, 1.65, 0.9, -0.03],
    thumb: thumbTo([0.035, 0.105, -0.005], [-0.5, 0, -1], 0.08),
  },
  pinch: {
    Index: PINCH_INDEX,
    Middle: [0.04, 0.05, 0.03, 0.04],
    Ring: [0.05, 0.05, 0.03, -0.1],
    Pinky: [0.06, 0.05, 0.03, -0.26],
    thumb: thumbTo(padContact("Index", PINCH_INDEX), [0, 1, -0.5], 0.35),
  },
};

export function cloneHandPose(p: HandPose): HandPose {
  return {
    Index: [...p.Index] as FingerCurl,
    Middle: [...p.Middle] as FingerCurl,
    Ring: [...p.Ring] as FingerCurl,
    Pinky: [...p.Pinky] as FingerCurl,
    thumb: p.thumb.map((d) => [...d] as V3) as [V3, V3, V3],
  };
}

export function lerpHandPose(a: HandPose, b: HandPose, t: number, out: HandPose = cloneHandPose(a)): HandPose {
  for (const f of CURLED_FINGERS) {
    for (let i = 0; i < 4; i++) out[f][i] = a[f][i] + (b[f][i] - a[f][i]) * t;
  }
  for (let k = 0; k < 3; k++) {
    const x = a.thumb[k][0] + (b.thumb[k][0] - a.thumb[k][0]) * t;
    const y = a.thumb[k][1] + (b.thumb[k][1] - a.thumb[k][1]) * t;
    const z = a.thumb[k][2] + (b.thumb[k][2] - a.thumb[k][2]) * t;
    out.thumb[k] = norm([x, y, z]);
  }
  return out;
}

/** Манжанын 3 сегментинин абстракттуу (f, s, n) багыттары */
export function fingerSegmentDirs(c: FingerCurl): [V3, V3, V3] {
  const [mcp, pip, dip, splay] = c;
  const cs = Math.cos(splay);
  const sn = Math.sin(splay);
  const out: V3[] = [];
  let phi = 0;
  for (const a of [mcp, pip, dip]) {
    phi += a;
    out.push([Math.cos(phi) * cs, Math.cos(phi) * sn, Math.sin(phi)]);
  }
  return out as [V3, V3, V3];
}
