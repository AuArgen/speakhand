// Ретаргетинг: MocapFrame / KeyframeClip → Mixamo аталыштуу каалаган ригдин сөөктөрү.
// Ар бир сөөктүн тынч абалдагы багыты (сөөк → бала) дүйнөлүк bind-позадан эсептелет,
// ошондуктан окторду катуу коддоо жок — Blender/Mixamo GLB да ушул эле код менен иштейт.
// Бардык эсептөөлөр "аватар мейкиндигинде" (rig.root'тун локалдык мейкиндиги) жүрөт.
import * as THREE from "three";
import type { HandTarget, KeyframeClip, MocapClip, MocapFrame, SignKey, Vec3 } from "../lib/types";
import { FACE_KEYS, isFaceKey, neutralFace, type FaceState } from "./face";
import {
  CURLED_FINGERS,
  HANDSHAPES,
  PROCEDURAL_HAND_GEOMETRY,
  cloneHandPose,
  fingerSegmentDirs,
  lerpHandPose,
  retargetThumb,
  type FingerGeometry,
  type HandGeometry,
  type HandPose,
  type V3,
} from "./handshapes";
import { FINGER_NAMES, SIDES, TORSO_DEPTH, TORSO_R, type AvatarRig, type FingerName, type Side } from "./rig";

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _s = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();

/** Процедуралык ригдеги ийин бийиктиги (жамбаштан) — HandTarget'терди масштабдоо үчүн */
export const REFERENCE_SHOULDER_HEIGHT = 0.455;

/**
 * Ички кеңейтилген манжа багыттары (жалпы HandTarget тибин өзгөртпөй):
 *  "back" — артка (денеге карай), "chest" — өз көкүрөгүн көрсөтүү (МЕН).
 */
export type ExtFingers = NonNullable<HandTarget["fingers"]> | "back" | "chest";
export interface ExtHandTarget extends Omit<HandTarget, "fingers"> {
  fingers?: ExtFingers;
}

interface BoneInfo {
  name: string;
  bone: THREE.Bone;
  restLocalQ: THREE.Quaternion;
  restWorldQ: THREE.Quaternion;
  restWorldPos: THREE.Vector3;
  /** Тынч абалда бала-сөөккө багыт, сөөктүн өз локалдык кадрында */
  dirLocal: THREE.Vector3 | null;
}

export interface HandBasis {
  F: THREE.Vector3;
  S: THREE.Vector3;
  N: THREE.Vector3;
}

const fingerBone = (side: Side, f: FingerName, k: number) => `${side}Hand${f}${k}`;

/**
 * Дененин көлөмү (тулку = эллипстик цилиндр, баш = сфера) — билек/чыканак аны аралап өтпөшү үчүн.
 * Бардык өлчөмдөр ригдин масштабына көбөйтүлөт.
 */
export class BodyVolume {
  readonly hipsY: number;
  readonly headCenter = new THREE.Vector3();
  readonly headR: number;
  constructor(
    readonly scale: number,
    hips: THREE.Vector3,
    headPos: THREE.Vector3,
  ) {
    this.hipsY = hips.y;
    this.headCenter.copy(headPos).add(new THREE.Vector3(0, 0.1 * scale, 0.018 * scale));
    this.headR = 0.108 * scale;
  }

  /** Тулкунун `y` бийиктигиндеги жарым туурасы жана жарым тереңдиги (аватар мейкиндиги) */
  torsoRadii(y: number, out: { a: number; b: number }): { a: number; b: number } {
    const h = 1.0 + (y - this.hipsY) / this.scale;
    const r = TORSO_R(h) * this.scale;
    out.a = r;
    out.b = r * TORSO_DEPTH(h) * 1.05 + 0.006 * this.scale;
    return out;
  }

  private tmpR = { a: 0, b: 0 };

  /** Чекит денеге кирип кетсе (margin менен), сыртка чыгарат. Канча чыгарылганын кайтарат. */
  pushOut(p: THREE.Vector3, margin: number): number {
    let moved = 0;
    const h = (p.y - this.hipsY) / this.scale;
    if (h > -0.3 && h < 0.56) {
      const { a, b } = this.torsoRadii(p.y, this.tmpR);
      const A = a + margin;
      const B = b + margin;
      const x = p.x;
      const z = p.z - 0.004 * this.scale;
      const e = (x * x) / (A * A) + (z * z) / (B * B);
      if (e < 1) {
        if (e < 1e-6) {
          moved = B - z;
          p.z = 0.004 * this.scale + B;
        } else {
          const k = 1 / Math.sqrt(e);
          const nx = x * k;
          const nz = z * k;
          moved = Math.hypot(nx - x, nz - z);
          p.x = nx;
          p.z = nz + 0.004 * this.scale;
        }
      }
    }
    const d = _v3.copy(p).sub(this.headCenter);
    const R = this.headR + margin;
    const dist = d.length();
    if (dist < R) {
      if (dist < 1e-6) d.set(0, 0, 1);
      else d.divideScalar(dist);
      p.copy(this.headCenter).addScaledVector(d, R);
      moved += R - dist;
    }
    return moved;
  }

  /** Чекит тулку/баштын ичиндеби (margin менен) */
  inside(p: THREE.Vector3, margin: number): boolean {
    const q = _v1.copy(p);
    return this.pushOut(q, margin) > 1e-6;
  }
}

/** Ригдин үстүндөгү төмөнкү деңгээлдеги операциялар (aim, IK, колдун базиси...) */
export class RigSolver {
  readonly rig: AvatarRig;
  readonly order: BoneInfo[] = [];
  private info = new Map<string, BoneInfo>();
  private rootInv = new THREE.Matrix4();
  private rootInvQ = new THREE.Quaternion();
  readonly hipsRest = new THREE.Vector3();
  /** Риг/процедуралык риг өлчөм катышы */
  readonly scale: number;
  readonly body: BodyVolume;
  private handLocal: Record<Side, HandBasis>;
  private armLen: Record<Side, { a: number; b: number }>;
  private chains: Record<Side, BoneInfo[]>;
  /** Ар бир колдун өлчөнгөн геометриясы (колдун кадрында) — бармакты которуу үчүн; толук эмес болсо null */
  readonly handGeom: Record<Side, HandGeometry | null>;
  /** Акыркы колдонулган манжа формасы (өткөөл үчүн) */
  readonly lastPose: Record<Side, HandPose> = { Left: cloneHandPose(HANDSHAPES.rest), Right: cloneHandPose(HANDSHAPES.rest) };

  constructor(rig: AvatarRig) {
    this.rig = rig;
    rig.root.updateMatrixWorld(true);
    this.rootInv.copy(rig.root.matrixWorld).invert();
    // Иерархия тартибинде (ата мурда)
    const seen = new Set<THREE.Bone>();
    const byBone = new Map<THREE.Bone, string>();
    for (const [n, b] of rig.bones) byBone.set(b, n);
    rig.root.traverse((o) => {
      const b = o as THREE.Bone;
      if (seen.has(b) || !byBone.has(b)) return;
      const name = byBone.get(b);
      if (!name) return;
      seen.add(b);
      _m1.multiplyMatrices(this.rootInv, b.matrixWorld);
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      _m1.decompose(pos, q, _s);
      const inf: BoneInfo = { name, bone: b, restLocalQ: b.quaternion.clone(), restWorldQ: q, restWorldPos: pos, dirLocal: null };
      this.order.push(inf);
      this.info.set(name, inf);
    });

    // Тынч багыттар
    const child: Record<string, string[]> = {
      Hips: ["Spine"],
      Spine: ["Spine1", "Spine2", "Neck"],
      Spine1: ["Spine2", "Neck"],
      Spine2: ["Neck"],
      Neck: ["Head"],
      Head: ["HeadTop_End"],
    };
    for (const side of SIDES) {
      child[`${side}Shoulder`] = [`${side}Arm`];
      child[`${side}Arm`] = [`${side}ForeArm`];
      child[`${side}ForeArm`] = [`${side}Hand`];
      child[`${side}Hand`] = [`${side}HandMiddle1`];
      for (const f of FINGER_NAMES) for (let k = 1; k <= 3; k++) child[fingerBone(side, f, k)] = [fingerBone(side, f, k + 1)];
    }
    for (const inf of this.order) {
      const cands = child[inf.name];
      let target: BoneInfo | undefined;
      if (cands) for (const c of cands) if ((target = this.info.get(c))) break;
      let dirWorld: THREE.Vector3 | null = null;
      if (target) dirWorld = target.restWorldPos.clone().sub(inf.restWorldPos);
      else {
        const parent = inf.bone.parent as THREE.Bone;
        const pInf = parent && byBone.get(parent) ? this.info.get(byBone.get(parent)!) : undefined;
        if (pInf) dirWorld = inf.restWorldPos.clone().sub(pInf.restWorldPos);
      }
      if (dirWorld && dirWorld.lengthSq() > 1e-12) {
        inf.dirLocal = dirWorld.normalize().applyQuaternion(inf.restWorldQ.clone().invert());
      }
    }

    this.hipsRest.copy(this.get("Hips").restWorldPos);
    const shoulder = this.info.get("LeftArm")!.restWorldPos;
    this.scale = Math.max(0.2, (shoulder.y - this.hipsRest.y) / REFERENCE_SHOULDER_HEIGHT);
    this.body = new BodyVolume(this.scale, this.hipsRest, this.get("Head").restWorldPos);

    this.handLocal = {} as Record<Side, HandBasis>;
    this.armLen = {} as Record<Side, { a: number; b: number }>;
    this.chains = {} as Record<Side, BoneInfo[]>;
    for (const side of SIDES) {
      const hand = this.get(`${side}Hand`);
      const arm = this.get(`${side}Arm`);
      const fore = this.get(`${side}ForeArm`);
      this.armLen[side] = { a: fore.restWorldPos.distanceTo(arm.restWorldPos), b: hand.restWorldPos.distanceTo(fore.restWorldPos) };
      const mid = this.info.get(`${side}HandMiddle1`);
      const idx = this.info.get(`${side}HandIndex1`);
      const pinky = this.info.get(`${side}HandPinky1`);
      const F = mid ? mid.restWorldPos.clone().sub(hand.restWorldPos) : hand.restWorldPos.clone().sub(fore.restWorldPos);
      F.normalize();
      const S = idx && pinky ? idx.restWorldPos.clone().sub(pinky.restWorldPos) : new THREE.Vector3(0, 0, 1);
      S.addScaledVector(F, -S.dot(F)).normalize();
      const N = side === "Left" ? new THREE.Vector3().crossVectors(F, S) : new THREE.Vector3().crossVectors(S, F);
      const inv = hand.restWorldQ.clone().invert();
      this.handLocal[side] = { F: F.applyQuaternion(inv), S: S.applyQuaternion(inv), N: N.normalize().applyQuaternion(inv) };
      const names = [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`];
      for (const f of FINGER_NAMES) for (let k = 1; k <= 4; k++) names.push(fingerBone(side, f, k));
      this.chains[side] = names.map((n) => this.info.get(n)).filter((x): x is BoneInfo => !!x);
    }
    this.handGeom = { Left: this.measureHand("Left"), Right: this.measureHand("Right") };
  }

  /** Тынч позадан колдун геометриясын өлчөө (колдун кадрында: f, s, n). Манжа сөөктөрү толук эмес болсо null. */
  private measureHand(side: Side): HandGeometry | null {
    const hand = this.info.get(`${side}Hand`);
    const l = this.handLocal[side];
    if (!hand || !l) return null;
    const inv = hand.restWorldQ.clone().invert();
    const toHand = (p: THREE.Vector3): V3 => {
      const d = p.clone().sub(hand.restWorldPos).applyQuaternion(inv);
      return [d.dot(l.F), d.dot(l.S), d.dot(l.N)];
    };
    const finger = (f: FingerName): FingerGeometry | null => {
      const pts: THREE.Vector3[] = [];
      for (let k = 1; k <= 4; k++) {
        const b = this.info.get(fingerBone(side, f, k));
        if (!b) break;
        pts.push(b.restWorldPos);
      }
      if (pts.length < 3) return null;
      const lens: number[] = [];
      for (let k = 0; k < 3; k++) {
        if (k + 1 < pts.length) lens.push(pts[k + 1].distanceTo(pts[k]));
        else lens.push(lens[k - 1] * 0.8); // учу жок болсо — акыркы фалангага жакын узундук
      }
      return { base: toHand(pts[0]), lens: lens as V3 };
    };
    const fingers = {} as Record<(typeof CURLED_FINGERS)[number], FingerGeometry>;
    for (const f of CURLED_FINGERS) {
      const g = finger(f);
      if (!g) return null;
      fingers[f] = g;
    }
    const thumb = finger("Thumb");
    const mid = this.info.get(`${side}HandMiddle1`);
    if (!thumb || !mid) return null;
    return { fingers, thumb, palm: mid.restWorldPos.distanceTo(hand.restWorldPos) };
  }

  get(name: string): BoneInfo {
    const i = this.info.get(name);
    if (!i) throw new Error(`Сөөк жок: ${name}`);
    return i;
  }
  has(name: string): boolean {
    return this.info.has(name);
  }
  armLength(side: Side): { a: number; b: number } {
    return this.armLen[side];
  }
  restPos(name: string): THREE.Vector3 {
    return this.get(name).restWorldPos;
  }

  beginFrame(): void {
    this.rig.root.updateMatrixWorld(true);
    this.rootInv.copy(this.rig.root.matrixWorld).invert();
    this.rig.root.getWorldQuaternion(this.rootInvQ).invert();
  }

  resetPose(): void {
    for (const i of this.order) i.bone.quaternion.copy(i.restLocalQ);
  }

  /** Сөөктүн (же анын атасынын) аватар мейкиндигиндеги айлануусу */
  worldQ(obj: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    obj.getWorldQuaternion(out);
    return out.premultiply(this.rootInvQ);
  }
  worldPos(name: string, out: THREE.Vector3): THREE.Vector3 {
    this.get(name).bone.getWorldPosition(out);
    return out.applyMatrix4(this.rootInv);
  }

  setWorldQ(name: string, q: THREE.Quaternion, weight = 1): void {
    const inf = this.info.get(name);
    if (!inf) return;
    const parentQ = this.worldQ(inf.bone.parent!, _q1);
    const local = _q2.copy(parentQ).invert().multiply(q);
    if (weight >= 1) inf.bone.quaternion.copy(local);
    else inf.bone.quaternion.slerp(local, weight);
  }

  /** world' = q · world (аватар мейкиндигинде кошумча айлантуу) */
  rotateWorld(name: string, q: THREE.Quaternion, weight = 1): void {
    const inf = this.info.get(name);
    if (!inf) return;
    const w = this.worldQ(inf.bone, _q3);
    const d = weight >= 1 ? _q1.copy(q) : _q1.copy(IDENTITY).slerp(q, weight);
    const target = d.multiply(w);
    this.setWorldQ(name, target.clone());
  }

  /** Сөөктү тынч багытынан `dir`ге минималдуу "swing" менен буруу (twist сакталат) */
  aim(name: string, dir: THREE.Vector3, weight = 1): void {
    const inf = this.info.get(name);
    if (!inf || !inf.dirLocal || dir.lengthSq() < 1e-12) return;
    const parentQ = this.worldQ(inf.bone.parent!, _q1).clone();
    const restWorld = _q2.copy(parentQ).multiply(inf.restLocalQ);
    const cur = _v1.copy(inf.dirLocal).applyQuaternion(restWorld);
    const tgt = _v2.copy(dir).normalize();
    const swing = _q3.setFromUnitVectors(cur, tgt);
    if (weight < 1) swing.slerp(IDENTITY, 1 - weight);
    const world = swing.multiply(restWorld);
    inf.bone.quaternion.copy(parentQ.invert().multiply(world));
  }

  /** Сөөктүн учурдагы ата-кадрындагы "тынч" багыты (аватар мейкиндигинде) */
  restDirNow(name: string, out: THREE.Vector3): THREE.Vector3 {
    const inf = this.get(name);
    const parentQ = this.worldQ(inf.bone.parent!, _q1);
    return out.copy(inf.dirLocal ?? Y_UP).applyQuaternion(_q2.copy(parentQ).multiply(inf.restLocalQ));
  }

  /** Колдун учурдагы базиси (аватар мейкиндигинде) */
  handBasis(side: Side, out: HandBasis): HandBasis {
    const q = this.worldQ(this.get(`${side}Hand`).bone, _q3);
    const l = this.handLocal[side];
    out.F.copy(l.F).applyQuaternion(q);
    out.S.copy(l.S).applyQuaternion(q);
    out.N.copy(l.N).applyQuaternion(q);
    return out;
  }

  /** F (манжалар) жана N (алакан) берилсе, колдун дүйнөлүк айлануусун эсептейт */
  handWorldQ(side: Side, F: THREE.Vector3, N: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
    const f = _v1.copy(F).normalize();
    const n = _v2.copy(N).addScaledVector(f, -N.dot(f));
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0).addScaledVector(f, -f.y);
    n.normalize();
    const s = side === "Left" ? _v3.crossVectors(n, f) : _v3.crossVectors(f, n);
    _m1.makeBasis(f, s, n);
    const l = this.handLocal[side];
    _m2.makeBasis(l.F, l.S, l.N).transpose();
    _m1.multiply(_m2);
    return out.setFromRotationMatrix(_m1);
  }

  orientHand(side: Side, F: THREE.Vector3, N: THREE.Vector3, weight = 1): void {
    const q = this.handWorldQ(side, F, N, new THREE.Quaternion());
    this.setWorldQ(`${side}Hand`, q, weight);
  }

  /** Эки сөөктүү аналитикалык IK: билекти `target`ке (аватар мейкиндиги) коёт */
  ikArm(side: Side, target: THREE.Vector3, pole: THREE.Vector3): void {
    const S = this.worldPos(`${side}Arm`, new THREE.Vector3());
    const { a, b } = this.armLen[side];
    const d = target.clone().sub(S);
    let dist = d.length();
    const u = dist > 1e-6 ? d.divideScalar(dist) : new THREE.Vector3(0, -1, 0);
    dist = THREE.MathUtils.clamp(dist, Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    const p = pole.clone().addScaledVector(u, -pole.dot(u));
    if (p.lengthSq() < 1e-8) p.set(side === "Left" ? 1 : -1, 0, -0.3).addScaledVector(u, -u.x);
    p.normalize();
    const E = S.clone().addScaledVector(u, x).addScaledVector(p, h);
    this.aim(`${side}Arm`, E.clone().sub(S));
    const elbow = this.worldPos(`${side}ForeArm`, new THREE.Vector3());
    const T = S.clone().addScaledVector(u, dist);
    this.aim(`${side}ForeArm`, T.sub(elbow));
  }

  /** IK'нин чыканак ордун гана эсептейт (берилген ийин ордунан) */
  estimateElbow(side: Side, target: THREE.Vector3, pole: THREE.Vector3, shoulder?: THREE.Vector3): THREE.Vector3 {
    const S = shoulder ?? this.get(`${side}Arm`).restWorldPos;
    const { a, b } = this.armLen[side];
    const d = target.clone().sub(S);
    let dist = d.length();
    const u = dist > 1e-6 ? d.divideScalar(dist) : new THREE.Vector3(0, -1, 0);
    dist = THREE.MathUtils.clamp(dist, Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
    const x = (a * a - b * b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    const p = pole.clone().addScaledVector(u, -pole.dot(u));
    if (p.lengthSq() < 1e-8) p.set(side === "Left" ? 1 : -1, 0, 0);
    p.normalize();
    return S.clone().addScaledVector(u, x).addScaledVector(p, h);
  }

  /**
   * Билектин бурулушунун (pronation/supination) бир бөлүгүн билек сөөгүнө (ForeArm) өткөрүү —
   * болбосо билек "кагаз ороочу" сыяктуу сынып көрүнөт. Колдун дүйнөлүк айлануусу өзгөрбөйт.
   */
  distributeForearmTwist(side: Side, k = 0.6): void {
    const fore = this.info.get(`${side}ForeArm`);
    const hand = this.info.get(`${side}Hand`);
    if (!fore || !hand || !fore.dirLocal) return;
    const handWorld = this.worldQ(hand.bone, _q1).clone();
    // Колдун билекке салыштырмалуу айлануусу, тынч абалга карата
    const local = _q2.copy(hand.bone.quaternion).multiply(_q3.copy(hand.restLocalQ).invert());
    // Swing-twist: огу = билек → кол багыты (билектин локалдык кадрында)
    const axis = fore.dirLocal;
    const proj = local.x * axis.x + local.y * axis.y + local.z * axis.z;
    if (proj * proj + local.w * local.w < 1e-8) return;
    // twist = (sin(θ/2)·axis, cos(θ/2)) → θ = 2·atan2(proj, w), (−π, π] аралыгына келтирилет
    let angle = 2 * Math.atan2(proj, local.w);
    if (angle > Math.PI) angle -= 2 * Math.PI;
    if (angle < -Math.PI) angle += 2 * Math.PI;
    angle = THREE.MathUtils.clamp(angle, -2.4, 2.4);
    if (Math.abs(angle) < 1e-4) return;
    // Билек сөөгүн өз огунун айланасында k·angle бур
    const axisWorld = _v1.copy(axis).applyQuaternion(this.worldQ(fore.bone, _q2));
    const rot = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle * k);
    this.rotateWorld(`${side}ForeArm`, rot);
    this.setWorldQ(`${side}Hand`, handWorld);
  }

  /** Манжаларды колдун абстракттуу формасы боюнча коюу */
  applyHandPose(side: Side, pose: HandPose): void {
    const B = this.handBasis(side, { F: new THREE.Vector3(), S: new THREE.Vector3(), N: new THREE.Vector3() });
    const dir = new THREE.Vector3();
    const toWorld = (d: V3) => dir.copy(B.F).multiplyScalar(d[0]).addScaledVector(B.S, d[1]).addScaledVector(B.N, d[2]);
    for (const f of CURLED_FINGERS) {
      const dirs = fingerSegmentDirs(pose[f]);
      for (let k = 0; k < 3; k++) this.aim(fingerBone(side, f, k + 1), toWorld(dirs[k]));
    }
    // Бармак: форма процедуралык колго карата берилген — ушул ригдин чыныгы геометриясына которобуз
    const geom = this.handGeom[side];
    const thumb = geom && geom !== PROCEDURAL_HAND_GEOMETRY && this.rig.kind !== "procedural" ? retargetThumb(pose, geom) : pose.thumb;
    for (let k = 0; k < 3; k++) this.aim(fingerBone(side, "Thumb", k + 1), toWorld(thumb[k]));
    lerpHandPose(pose, pose, 0, this.lastPose[side]);
  }

  /** Ийинди (клавикула) бир аз көтөрүү/алдыга чыгаруу */
  shrug(side: Side, up: number, fwd: number): void {
    const name = `${side}Shoulder`;
    if (!this.has(name) || (Math.abs(up) < 1e-4 && Math.abs(fwd) < 1e-4)) return;
    const d = this.restDirNow(name, new THREE.Vector3());
    d.y += up;
    d.z += fwd;
    this.aim(name, d);
  }

  /** Баш: nod (+ = ээк ылдый), shake (+ = аватардын солуна), tilt (+ = оң ийинге) — радиан */
  headRotate(pitch: number, yaw: number, roll: number): void {
    if (Math.abs(pitch) + Math.abs(yaw) + Math.abs(roll) < 1e-5) return;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
    this.rotateWorld("Neck", q, 0.4);
    this.rotateWorld("Head", q, 0.6);
  }

  /** Тулку: pitch (+ = алдыга ийилүү), yaw (+ = солго бурулуу), roll (+ = солго жантаюу) — омуртка сөөктөрүнө бөлүштүрүлөт */
  torsoRotate(pitch: number, yaw: number, roll: number): void {
    if (Math.abs(pitch) + Math.abs(yaw) + Math.abs(roll) < 1e-5) return;
    const spines = ["Spine", "Spine1", "Spine2"].filter((n) => this.has(n));
    if (!spines.length) return;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch / spines.length, yaw / spines.length, roll / spines.length, "YXZ"));
    for (const n of spines) this.rotateWorld(n, q);
  }

  chain(side: Side): BoneInfo[] {
    return this.chains[side];
  }

  /** Учурдагы риг абалынан колдун үлгүсүн окуу (орду + айлануусу + акыркы манжа формасы) */
  readHandSample(side: Side, out: HandSample): HandSample {
    this.worldPos(`${side}Hand`, out.pos);
    this.worldQ(this.get(`${side}Hand`).bone, out.q);
    lerpHandPose(this.lastPose[side], this.lastPose[side], 0, out.pose);
    return out;
  }

  // ---- Позаны сактоо/аралаштыруу ----
  capture(out?: Float32Array): Float32Array {
    const arr = out ?? new Float32Array(this.order.length * 4);
    this.order.forEach((inf, i) => inf.bone.quaternion.toArray(arr, i * 4));
    return arr;
  }
  write(arr: Float32Array): void {
    this.order.forEach((inf, i) => inf.bone.quaternion.fromArray(arr, i * 4));
  }
  captureBones(list: BoneInfo[], out?: Float32Array): Float32Array {
    const arr = out ?? new Float32Array(list.length * 4);
    list.forEach((inf, i) => inf.bone.quaternion.toArray(arr, i * 4));
    return arr;
  }
  writeBonesBlend(list: BoneInfo[], a: Float32Array, b: Float32Array, t: number): void {
    list.forEach((inf, i) => {
      _q1.fromArray(a, i * 4);
      _q2.fromArray(b, i * 4);
      inf.bone.quaternion.slerpQuaternions(_q1, _q2, t);
    });
  }
  /** Сөөк индекстери (this.order ичинде) — маска түзүү үчүн */
  boneIndex(name: string): number {
    return this.order.findIndex((i) => i.name === name);
  }
}

const Y_UP = new THREE.Vector3(0, 1, 0);

/** Эки позаны аралаштыруу (out = a..b, t) */
export function blendPoses(a: Float32Array, b: Float32Array, t: number, out: Float32Array, mask?: Float32Array): Float32Array {
  for (let i = 0; i < a.length; i += 4) {
    _q1.fromArray(a, i);
    _q2.fromArray(b, i);
    const w = mask ? t + (1 - t) * (1 - mask[i >> 2]) : t;
    _q1.slerp(_q2, w).toArray(out, i);
  }
  return out;
}

export function blendFaces(a: FaceState, b: FaceState, t: number, out: FaceState): FaceState {
  for (const k of FACE_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

// ---------------------------------------------------------------------------
// Багыт сөздөрү → векторлор
// ---------------------------------------------------------------------------

type DirWord = HandTarget["palm"] | ExtFingers;

export function dirVector(word: DirWord, side: Side, out = new THREE.Vector3()): THREE.Vector3 {
  const inward = side === "Left" ? -1 : 1; // денеге карай (орто сызыкка)
  switch (word) {
    case "up":
      return out.set(0, 1, 0);
    case "down":
      return out.set(0, -1, 0);
    case "fwd":
      return out.set(0, 0, 1);
    case "back":
    case "chest":
      return out.set(0, 0, -1);
    case "in":
      return out.set(inward, 0, 0);
    case "out":
      return out.set(-inward, 0, 0);
  }
}

/** Чыканактын табигый багыты: ылдый, сыртка, бир аз артка; кол дененин аркы бетине өтсө — сыртка жана АЛДЫГА */
export function elbowPole(side: Side, target: THREE.Vector3, shoulder: THREE.Vector3): THREE.Vector3 {
  const s = side === "Left" ? 1 : -1;
  const cross = THREE.MathUtils.clamp(-(target.x - shoulder.x) * s / 0.3, 0, 1.5);
  const high = Math.max(0, target.y - shoulder.y + 0.15) / 0.3;
  const near = THREE.MathUtils.clamp(1 - (target.z - shoulder.z) / 0.25, 0, 1); // кол денеге жакын
  return new THREE.Vector3(s * (0.22 + 0.4 * cross + 0.05 * high), -1, -0.32 - 0.15 * high + 0.9 * cross + 0.25 * near * cross);
}

// ---------------------------------------------------------------------------
// Тынч абал (колдор белдин алдында бош турат)
// ---------------------------------------------------------------------------

export function restTarget(side: Side): HandTarget {
  const s = side === "Left" ? 1 : -1;
  return { pos: [0.11 * s, 0.17, 0.21], shape: "rest", palm: "in", fingers: "fwd" };
}

// ---------------------------------------------------------------------------
// Keyframe → поза
// ---------------------------------------------------------------------------

interface ResolvedKey {
  at: number;
  pos: THREE.Vector3;
  pose: HandPose;
  q: THREE.Quaternion;
}

interface ScalarKey {
  at: number;
  v: number;
}

const smooth = (u: number) => u * u * (3 - 2 * u);
const bump = (x: number) => (x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x));

/** HandTarget → аватар мейкиндигиндеги билектин орду + колдун айлануусу + манжалар */
export function resolveHandTarget(solver: RigSolver, side: Side, t: HandTarget | ExtHandTarget): { pos: THREE.Vector3; pose: HandPose; q: THREE.Quaternion } {
  const pos = new THREE.Vector3(t.pos[0], t.pos[1], t.pos[2]).multiplyScalar(solver.scale).add(solver.hipsRest);
  const N = dirVector(t.palm, side);
  const fingers = t.fingers as ExtFingers | undefined;
  let F: THREE.Vector3;
  if (fingers === "chest") {
    // Өз көкүрөгүн көрсөтүү: билектен төш сөөгүнө карай
    const chest = new THREE.Vector3(0, t.pos[1] - 0.03, 0.07).multiplyScalar(solver.scale).add(solver.hipsRest);
    F = chest.sub(pos).normalize();
  } else if (fingers && Math.abs(dirVector(fingers, side).dot(N)) < 0.9) {
    F = dirVector(fingers, side);
  } else if (t.palm === "in" || t.palm === "out") {
    // Алакандар бири-бирине караса — манжалар өйдө жана бир аз ортого кыйшайган (чатыр сыяктуу)
    F = new THREE.Vector3(0, 1, 0).addScaledVector(dirVector("in", side), 0.85).normalize();
  } else {
    // Манжалар билектин уландысы катары (чыканак → билек), алаканга перпендикуляр
    const shoulder = solver.restPos(`${side}Arm`);
    const elbow = solver.estimateElbow(side, pos, elbowPole(side, pos, shoulder));
    F = pos.clone().sub(elbow).normalize();
    F.addScaledVector(N, -F.dot(N));
    if (F.lengthSq() < 0.05) F = Math.abs(N.y) > 0.7 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    F.normalize();
  }
  const q = solver.handWorldQ(side, F, N, new THREE.Quaternion());
  return { pos, pose: cloneHandPose(HANDSHAPES[t.shape] ?? HANDSHAPES.rest), q };
}

export interface HandSample {
  pos: THREE.Vector3;
  pose: HandPose;
  q: THREE.Quaternion;
}

export function newHandSample(): HandSample {
  return { pos: new THREE.Vector3(), pose: cloneHandPose(HANDSHAPES.rest), q: new THREE.Quaternion() };
}

export function copyHandSample(src: HandSample, out: HandSample): HandSample {
  out.pos.copy(src.pos);
  out.q.copy(src.q);
  lerpHandPose(src.pose, src.pose, 0, out.pose);
  return out;
}

// ---- Денеге салыштырмалуу (цилиндрдик) интерполяция ----
// Кол дененин огунун айланасында жаа менен жылат (түз сызык менен көкүрөк аркылуу эмес),
// жана жолдун ортосунда бир аз алдыга чыгат.

const AXIS_Z = -0.03; // айлануу огу тулкунун борборунан бир аз артта (алдыңкы жаа кененирээк)

function toCyl(p: THREE.Vector3, hips: THREE.Vector3, scale: number, out: THREE.Vector3): THREE.Vector3 {
  const x = p.x - hips.x;
  const z = p.z - hips.z - AXIS_Z * scale;
  return out.set(Math.atan2(x, z), Math.hypot(x, z), p.y);
}
function fromCyl(c: THREE.Vector3, hips: THREE.Vector3, scale: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(hips.x + c.y * Math.sin(c.x), c.z, hips.z + AXIS_Z * scale + c.y * Math.cos(c.x));
}

const _c0 = new THREE.Vector3();
const _c1 = new THREE.Vector3();
const _cm = new THREE.Vector3();

/**
 * Эки билек ордунун ортосундагы дене-аң-сезимдүү интерполяция: цилиндрдик координаттарда,
 * алдыга бүгүлгөн жаа менен, анан денеден сыртка түртүү.
 */
export function lerpAroundBody(solver: RigSolver, a: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3, margin = 0.045): THREE.Vector3 {
  const hips = solver.hipsRest;
  const sc = solver.scale;
  toCyl(a, hips, sc, _c0);
  toCyl(b, hips, sc, _c1);
  // Бурчту кыска жол менен
  let dth = _c1.x - _c0.x;
  if (dth > Math.PI) dth -= 2 * Math.PI;
  if (dth < -Math.PI) dth += 2 * Math.PI;
  const th = _c0.x + dth * u;
  const r = _c0.y + (_c1.y - _c0.y) * u;
  const y = _c0.z + (_c1.z - _c0.z) * u;
  // Алдыга чыгуу: канчалык чоң бурулуш болсо, ошончолук
  const bulge = (0.05 * Math.min(1, Math.abs(dth) / 0.9) + 0.012 * Math.min(1, Math.abs(_c1.z - _c0.z) / 0.25)) * sc;
  _cm.set(th, r + bulge * bump(u), y);
  fromCyl(_cm, hips, sc, out);
  solver.body.pushOut(out, margin * sc);
  return out;
}

/** Эки кол үлгүсүн аралаштыруу (дене-аң-сезимдүү жол менен) */
export function blendHandSamples(solver: RigSolver, a: HandSample, b: HandSample, u: number, out: HandSample): HandSample {
  lerpAroundBody(solver, a.pos, b.pos, u, out.pos);
  out.q.slerpQuaternions(a.q, b.q, u);
  lerpHandPose(a.pose, b.pose, u, out.pose);
  return out;
}

/** Эки билек бири-бирине өтө жакындаса — ажыратуу (колдор бири-бирин аралап өтпөшү үчүн) */
export function separateHands(solver: RigSolver, L: THREE.Vector3, R: THREE.Vector3, minDist = 0.075): void {
  const d = _v1.copy(L).sub(R);
  const dist = d.length();
  const min = minDist * solver.scale;
  if (dist >= min || dist < 1e-6) return;
  // Негизинен x (капталга) боюнча ажыратабыз; сол кол +x жакка
  const push = (min - dist) / 2;
  d.divideScalar(dist);
  if (d.x < 0.2) d.set(1, 0, 0).lerp(d, 0.3).normalize();
  L.addScaledVector(d, push);
  R.addScaledVector(d, -push);
}

/** Бир колду коюу: IK + багыт + манжалар (+ ийинди бир аз көтөрүү, билек twist'ин бөлүштүрүү, чыканак денеден сырт) */
export function applyHandSample(solver: RigSolver, side: Side, h: HandSample): void {
  const shoulder = solver.worldPos(`${side}Arm`, new THREE.Vector3());
  const rel = h.pos.y - shoulder.y;
  const s = side === "Left" ? 1 : -1;
  const across = Math.max(0, -(h.pos.x - shoulder.x) * s);
  solver.shrug(side, Math.max(0, rel + 0.12) * 0.35, Math.max(0, h.pos.z - 0.2) * 0.25 + across * 0.3);
  const sh = solver.worldPos(`${side}Arm`, new THREE.Vector3());
  const pole = elbowPole(side, h.pos, sh);
  // Билек (чыканак → билек) денеге кирип кетпесин: керек болсо чыканакты алдыга чыгарабыз
  const mid = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    const elbow = solver.estimateElbow(side, h.pos, pole, sh);
    let ok = !solver.body.inside(elbow, 0.03 * solver.scale);
    if (ok) {
      mid.lerpVectors(elbow, h.pos, 0.5);
      ok = !solver.body.inside(mid, 0.04 * solver.scale);
    }
    if (ok) {
      mid.lerpVectors(elbow, h.pos, 0.75);
      ok = !solver.body.inside(mid, 0.04 * solver.scale);
    }
    if (ok) break;
    pole.z += 0.6;
    pole.x += s * 0.2;
  }
  solver.ikArm(side, h.pos, pole);
  solver.setWorldQ(`${side}Hand`, h.q);
  solver.distributeForearmTwist(side, 0.6);
  solver.applyHandPose(side, h.pose);
}

interface HandEntry {
  sample: HandSample;
  ms: number;
}

export class KeyframePlayer {
  readonly duration: number;
  private hands: Record<Side, ResolvedKey[]>;
  private scalars = new Map<string, ScalarKey[]>();
  private tmpPose: Record<Side, HandPose>;
  private entry: Partial<Record<Side, HandEntry>> = {};
  private samples: Record<Side, HandSample> = { Left: newHandSample(), Right: newHandSample() };
  private blendTmp = newHandSample();
  private restPos: Record<Side, THREE.Vector3>;
  private headPos: THREE.Vector3;
  private _lean = new THREE.Vector3();
  private _look = new THREE.Vector3();
  private _d = new THREE.Vector3();

  constructor(
    private solver: RigSolver,
    clip: KeyframeClip,
  ) {
    this.duration = Math.max(1, clip.duration);
    const keys = [...clip.keys].sort((a, b) => a.at - b.at);
    this.hands = { Left: [], Right: [] };
    this.tmpPose = { Left: cloneHandPose(HANDSHAPES.rest), Right: cloneHandPose(HANDSHAPES.rest) };
    this.restPos = { Left: resolveHandTarget(solver, "Left", restTarget("Left")).pos, Right: resolveHandTarget(solver, "Right", restTarget("Right")).pos };
    this.headPos = solver.body.headCenter.clone();
    for (const side of SIDES) {
      const prop = side === "Left" ? "left" : "right";
      for (const k of keys) {
        const v = k[prop];
        if (v === undefined) continue;
        const target = v === "rest" ? restTarget(side) : v;
        const r = resolveHandTarget(solver, side, target);
        this.hands[side].push({ at: THREE.MathUtils.clamp(k.at, 0, 1), ...r });
      }
    }
    const addScalar = (name: string, at: number, v: number) => {
      let arr = this.scalars.get(name);
      if (!arr) this.scalars.set(name, (arr = []));
      arr.push({ at, v });
    };
    for (const k of keys as SignKey[]) {
      if (k.head) {
        if (k.head.nod !== undefined) addScalar("head.nod", k.at, k.head.nod);
        if (k.head.shake !== undefined) addScalar("head.shake", k.at, k.head.shake);
        if (k.head.tilt !== undefined) addScalar("head.tilt", k.at, k.head.tilt);
      }
      if (k.face) for (const [n, v] of Object.entries(k.face)) if (isFaceKey(n)) addScalar(`face.${n}`, k.at, v);
    }
  }

  hasHand(side: Side): boolean {
    return this.hands[side].length > 0;
  }

  /** Жесттин башында мурунку абалдан (башка жест / тынч абал) жылмакай өтүү */
  setEntry(samples: Partial<Record<Side, HandSample>>, ms: number): void {
    this.entry = {};
    if (ms <= 0) return;
    for (const side of SIDES) {
      const s = samples[side];
      if (s && this.hasHand(side)) this.entry[side] = { sample: copyHandSample(s, newHandSample()), ms };
    }
  }

  sampleHand(side: Side, tn: number, out: HandSample): boolean {
    const keys = this.hands[side];
    if (!keys.length) return false;
    if (keys.length === 1 || tn <= keys[0].at) {
      out.pos.copy(keys[0].pos);
      out.q.copy(keys[0].q);
      lerpHandPose(keys[0].pose, keys[0].pose, 0, out.pose);
      return true;
    }
    const last = keys[keys.length - 1];
    if (tn >= last.at) {
      out.pos.copy(last.pos);
      out.q.copy(last.q);
      lerpHandPose(last.pose, last.pose, 0, out.pose);
      return true;
    }
    let i = 0;
    while (i < keys.length - 2 && tn > keys[i + 1].at) i++;
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const span = Math.max(1e-4, k1.at - k0.at);
    const uRaw = (tn - k0.at) / span;
    // Ар бир сегментте жеңил ease-in/out (Catmull-Rom үзгүлтүксүздүгүн сактоо менен)
    const u = uRaw + 0.35 * (smooth(uRaw) - uRaw);
    // Позиция: Эрмит сплайны цилиндрдик (дене) координаттарда, Catmull-Rom тангенстери (учтарында 0)
    const sc = this.solver.scale;
    const hips = this.solver.hipsRest;
    const c0 = toCyl(k0.pos, hips, sc, new THREE.Vector3());
    const c1 = toCyl(k1.pos, hips, sc, new THREE.Vector3());
    if (c1.x - c0.x > Math.PI) c1.x -= 2 * Math.PI;
    if (c1.x - c0.x < -Math.PI) c1.x += 2 * Math.PI;
    const tangent = (j: number, ref: THREE.Vector3, outV: THREE.Vector3) => {
      if (j <= 0 || j >= keys.length - 1) return outV.set(0, 0, 0);
      const a = toCyl(keys[j - 1].pos, hips, sc, _c0);
      const b = toCyl(keys[j + 1].pos, hips, sc, _c1);
      for (const c of [a, b]) {
        if (c.x - ref.x > Math.PI) c.x -= 2 * Math.PI;
        if (c.x - ref.x < -Math.PI) c.x += 2 * Math.PI;
      }
      const dt = Math.max(1e-4, keys[j + 1].at - keys[j - 1].at);
      return outV.copy(b).sub(a).multiplyScalar((0.75 * span) / dt);
    };
    const m0 = tangent(i, c0, new THREE.Vector3());
    const m1 = tangent(i + 1, c1, new THREE.Vector3());
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    _cm.copy(c0).multiplyScalar(h00).addScaledVector(m0, h10).addScaledVector(c1, h01).addScaledVector(m1, h11);
    // Жолдун ортосунда алдыга чыгуу (чоң бурулуштарда)
    const dth = Math.abs(c1.x - c0.x);
    _cm.y += (0.045 * Math.min(1, dth / 0.9) + 0.01 * Math.min(1, Math.abs(c1.z - c0.z) / 0.25)) * sc * bump(u);
    fromCyl(_cm, hips, sc, out.pos);
    // Анticипация / кармап калуу (follow-through): токтоп турган абалдан чоң кыймылга
    const dist = k0.pos.distanceTo(k1.pos);
    if (dist > 0.04 * sc) {
      const dir = _v2.copy(k1.pos).sub(k0.pos).divideScalar(dist);
      const amp = Math.min(1, dist / (0.14 * sc)) * sc;
      if (m0.lengthSq() < 1e-4) out.pos.addScaledVector(dir, -0.011 * amp * bump(u / 0.3));
      if (m1.lengthSq() < 1e-4) out.pos.addScaledVector(dir, 0.009 * amp * bump((u - 0.7) / 0.3));
    }
    this.solver.body.pushOut(out.pos, 0.045 * sc);
    const e = smooth(u);
    out.q.slerpQuaternions(k0.q, k1.q, e);
    lerpHandPose(k0.pose, k1.pose, e, out.pose);
    return true;
  }

  scalar(name: string, tn: number): number {
    const keys = this.scalars.get(name);
    if (!keys || !keys.length) return 0;
    if (tn <= keys[0].at) return keys[0].v;
    const last = keys[keys.length - 1];
    if (tn >= last.at) return last.v;
    let i = 0;
    while (i < keys.length - 2 && tn > keys[i + 1].at) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const u = (tn - a.at) / Math.max(1e-4, b.at - a.at);
    return a.v + (b.v - a.v) * smooth(u);
  }

  /** Клиптин `tMs` убактысындагы позаны ригге жазат. `restArm(side)` — колу жок болсо тынч абал. */
  apply(tMs: number, face: FaceState, restArm: (side: Side) => void): void {
    const tn = THREE.MathUtils.clamp(tMs / this.duration, 0, 1);
    const sv = this.solver;
    // 1) Колдордун үлгүлөрү (кирүү өткөөлү менен)
    for (const side of SIDES) {
      if (!this.hasHand(side)) continue;
      const sample = this.samples[side];
      sample.pose = this.tmpPose[side];
      this.sampleHand(side, tn, sample);
      const en = this.entry[side];
      if (en && tMs < en.ms) {
        const u = smooth(Math.max(0, tMs) / en.ms);
        blendHandSamples(sv, en.sample, sample, u, this.blendTmp);
        copyHandSample(this.blendTmp, sample);
      }
    }
    if (this.hasHand("Left") && this.hasHand("Right")) separateHands(sv, this.samples.Left.pos, this.samples.Right.pos);

    // 2) Экинчилик кыймыл: тулку активдүү колго карай бурулат/жантаят, баш ээрчийт, көз карайт
    let lean = this._lean.set(0, 0, 0);
    let activity = 0;
    const look = this._look.set(0, 0, 0);
    for (const side of SIDES) {
      if (!this.hasHand(side)) continue;
      const p = this.samples[side].pos;
      const d = this._d.copy(p).sub(this.restPos[side]).divideScalar(sv.scale);
      const a = THREE.MathUtils.clamp(d.length() / 0.18, 0, 1);
      lean.addScaledVector(d, a);
      if (a > activity) {
        activity = a;
        look.copy(p).sub(this.headPos).divideScalar(sv.scale);
      }
    }
    lean = lean.clampLength(0, 0.35);
    const yaw = THREE.MathUtils.clamp(0.22 * lean.x, -0.1, 0.1);
    const roll = THREE.MathUtils.clamp(-0.1 * lean.x, -0.045, 0.045);
    const pitch = THREE.MathUtils.clamp(0.12 * lean.z - 0.06 * lean.y, -0.05, 0.06);
    sv.torsoRotate(pitch, yaw, roll);

    // 3) Колдор (тулку бурулгандан КИЙИН — IK абсолюттук орунга)
    for (const side of SIDES) {
      if (!this.hasHand(side)) {
        restArm(side);
        continue;
      }
      applyHandSample(sv, side, this.samples[side]);
    }

    // 4) Баш: жест белгилери + колду бир аз ээрчүү; көз жесттин башында колго карайт
    const nod = this.scalar("head.nod", tn);
    const shake = this.scalar("head.shake", tn);
    const tilt = this.scalar("head.tilt", tn);
    let hYaw = 0;
    let hPitch = 0;
    if (activity > 0) {
      const ang = Math.atan2(look.x, Math.max(0.05, look.z));
      const el = Math.atan2(look.y, Math.hypot(look.x, look.z));
      hYaw = THREE.MathUtils.clamp(ang * 0.14, -0.12, 0.12) * activity;
      hPitch = THREE.MathUtils.clamp(-el * 0.1, -0.06, 0.08) * activity;
      const eyeW = activity * (1 - smooth(THREE.MathUtils.clamp((tn - 0.18) / 0.3, 0, 1)));
      face.eyeLookX += THREE.MathUtils.clamp(look.x / 0.3, -1, 1) * 0.7 * eyeW;
      face.eyeLookY += THREE.MathUtils.clamp(el / 0.9, -1, 1) * 0.8 * eyeW;
    }
    // Бир аз дене да кошулат: баш ийилгенде көкүрөк да бир аз
    sv.headRotate(nod * 0.38 + hPitch, shake * 0.5 + hYaw, -tilt * 0.3);
    for (const [name, keys] of this.scalars) {
      if (!name.startsWith("face.") || !keys.length) continue;
      const k = name.slice(5);
      if (isFaceKey(k)) face[k] = Math.max(face[k], this.scalar(name, tn));
    }
  }
}

// ---------------------------------------------------------------------------
// Mocap → поза
// ---------------------------------------------------------------------------

/** One-Euro фильтри (Casiez 2012) — ар бир чекит үчүн векторлук ылдамдык менен */
export class LandmarkFilter {
  private x: Float32Array | null = null;
  private dx: Float32Array;
  private tPrev = 0;
  constructor(
    private n: number,
    private minCutoff: number,
    private beta: number,
    private dCutoff = 1.0,
  ) {
    this.dx = new Float32Array(n);
  }
  reset(): void {
    this.x = null;
  }
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(points: Vec3[], t: number): Float32Array {
    const n = Math.min(this.n, points.length);
    if (!this.x || t <= this.tPrev) {
      if (!this.x) {
        this.x = new Float32Array(this.n * 3);
        for (let i = 0; i < n; i++) {
          this.x[i * 3] = points[i][0];
          this.x[i * 3 + 1] = points[i][1];
          this.x[i * 3 + 2] = points[i][2];
        }
        this.dx.fill(0);
        this.tPrev = t;
        return this.x;
      }
      t = this.tPrev + 1 / 60;
    }
    const dt = Math.min(0.25, Math.max(1e-3, t - this.tPrev));
    this.tPrev = t;
    const ad = LandmarkFilter.alpha(this.dCutoff, dt);
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const ex = points[i][0] - this.x[j];
      const ey = points[i][1] - this.x[j + 1];
      const ez = points[i][2] - this.x[j + 2];
      const speed = Math.hypot(ex, ey, ez) / dt;
      this.dx[i] += ad * (speed - this.dx[i]);
      const a = LandmarkFilter.alpha(this.minCutoff + this.beta * this.dx[i], dt);
      this.x[j] += a * ex;
      this.x[j + 1] += a * ey;
      this.x[j + 2] += a * ez;
    }
    return this.x;
  }
}

const P = (arr: Float32Array, i: number, out: THREE.Vector3) => out.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);

/** MediaPipe колунун 21 чекити: манжалар (MCP→PIP→DIP→TIP) */
const HAND_CHAINS: Record<FingerName, [number, number, number, number]> = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Pinky: [17, 18, 19, 20],
};

export class MocapRetargeter {
  private poseF = new LandmarkFilter(33, 1.4, 2.0);
  private handF: Record<Side, LandmarkFilter> = { Left: new LandmarkFilter(21, 1.8, 6), Right: new LandmarkFilter(21, 1.8, 6) };
  private presence: Record<Side, number> = { Left: 0, Right: 0 };
  private bodyPresence = 0;
  private last: Record<Side, Float32Array | null> = { Left: null, Right: null };
  private lastPose: Float32Array | null = null;
  private lastHand: Record<Side, Float32Array | null> = { Left: null, Right: null };
  private faceS: FaceState = neutralFace();
  private faceSeen = 0;

  constructor(private solver: RigSolver) {}

  reset(): void {
    this.poseF.reset();
    this.handF.Left.reset();
    this.handF.Right.reset();
    this.presence = { Left: 0, Right: 0 };
    this.bodyPresence = 0;
    this.last = { Left: null, Right: null };
    this.lastPose = null;
    this.lastHand = { Left: null, Right: null };
    this.faceS = neutralFace();
    this.faceSeen = 0;
  }

  /**
   * @param frame учурдагы кадр
   * @param tSec кадрдын убактысы (секунд) — фильтр үчүн
   * @param dt рендер кадрынын узактыгы
   * @param fresh жаңы кадрбы (фильтрди жаңылоо керекпи)
   * @param restArm тынч абалдагы колду коюучу функция
   */
  apply(frame: MocapFrame, tSec: number, dt: number, fresh: boolean, face: FaceState, restArm: (side: Side) => void): void {
    const sv = this.solver;
    const fade = 1 - Math.exp(-dt / 0.18);

    let pose: Float32Array | null = null;
    if (frame.pose && frame.pose.length >= 25) {
      pose = fresh || !this.lastPose ? this.poseF.filter(frame.pose, tSec) : this.lastPose;
      this.lastPose = pose;
    } else if (fresh) this.poseF.reset();
    this.bodyPresence += ((pose ? 1 : 0) - this.bodyPresence) * fade;

    // ---- Тулку жана баш ----
    if (pose && this.bodyPresence > 0.01) {
      const lS = P(pose, 11, new THREE.Vector3());
      const rS = P(pose, 12, new THREE.Vector3());
      const lH = P(pose, 23, new THREE.Vector3());
      const rH = P(pose, 24, new THREE.Vector3());
      const up = lS.clone().add(rS).sub(lH).sub(rH).normalize();
      const side = lS.clone().sub(rS);
      side.addScaledVector(up, -side.dot(up)).normalize();
      const fwd = new THREE.Vector3().crossVectors(side, up);
      const R = new THREE.Quaternion().setFromRotationMatrix(_m1.makeBasis(side, up, fwd));
      // Жамбаштар ар дайым түз деп эсептелет — айлануу омурткага бөлүштүрүлөт (жумшартылып)
      const w = this.bodyPresence * 0.85;
      const spines = ["Spine", "Spine1", "Spine2"].filter((n) => sv.has(n));
      const part = new THREE.Quaternion().slerp(R, 1 / spines.length);
      for (const n of spines) sv.rotateWorld(n, part, w);

      // Баш: мурун (0), кулактар (7 = сол, 8 = оң)
      const nose = P(pose, 0, new THREE.Vector3());
      const lE = P(pose, 7, new THREE.Vector3());
      const rE = P(pose, 8, new THREE.Vector3());
      const earMid = lE.clone().add(rE).multiplyScalar(0.5);
      const hf = nose.sub(earMid).normalize();
      const hs = lE.clone().sub(rE);
      hs.addScaledVector(hf, -hs.dot(hf)).normalize();
      const hu = new THREE.Vector3().crossVectors(hf, hs);
      const Rh = new THREE.Quaternion().setFromRotationMatrix(_m1.makeBasis(hs, hu, hf));
      // Мурун кулактан төмөн жайгашкандыктан ~0.3 рад өйдө түзөтүү
      Rh.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.3));
      const headTarget = Rh.multiply(sv.get("Head").restWorldQ);
      const cur = sv.worldQ(sv.get("Head").bone, new THREE.Quaternion());
      const delta = headTarget.clone().multiply(cur.invert());
      sv.rotateWorld("Neck", delta, 0.4 * this.bodyPresence);
      const curHead = sv.worldQ(sv.get("Head").bone, new THREE.Quaternion());
      sv.setWorldQ("Head", curHead.slerp(headTarget, this.bodyPresence));
    }

    // ---- Колдор ----
    for (const side of SIDES) {
      const handPts = side === "Left" ? frame.leftHand : frame.rightHand;
      const ok = !!(pose && handPts && handPts.length >= 21);
      if (!handPts && fresh) {
        this.handF[side].reset();
        this.lastHand[side] = null;
      }
      this.presence[side] += ((ok ? 1 : 0) - this.presence[side]) * fade;
      const chain = sv.chain(side);
      restArm(side);
      const restPose = sv.captureBones(chain);
      if (ok && pose) {
        const hp = fresh || !this.lastHand[side] ? this.handF[side].filter(handPts!, tSec) : this.lastHand[side]!;
        this.lastHand[side] = hp;
        this.solveArm(side, pose, hp);
        this.last[side] = sv.captureBones(chain, this.last[side] ?? undefined);
      }
      const w = this.presence[side];
      const last = this.last[side];
      if (last && w > 0.001) sv.writeBonesBlend(chain, restPose, last, smooth(Math.min(1, w)));
      else sv.writeBonesBlend(chain, restPose, restPose, 0);
    }

    // ---- Бет ----
    if (frame.face) {
      this.faceSeen = 1;
      const a = 1 - Math.exp(-dt / 0.06);
      for (const k of FACE_KEYS) {
        const v = frame.face[k];
        if (v !== undefined) this.faceS[k] += (v - this.faceS[k]) * a;
      }
    } else {
      this.faceSeen *= 1 - fade;
    }
    if (this.faceSeen > 0.01) for (const k of FACE_KEYS) face[k] = Math.max(face[k], this.faceS[k] * this.faceSeen);
  }

  private solveArm(side: Side, pose: Float32Array, hand: Float32Array) {
    const sv = this.solver;
    const [iS, iE, iW] = side === "Left" ? [11, 13, 15] : [12, 14, 16];
    const sh = P(pose, iS, new THREE.Vector3());
    const el = P(pose, iE, new THREE.Vector3());
    const wr = P(pose, iW, new THREE.Vector3());
    const upper = el.clone().sub(sh);
    const fore = wr.clone().sub(el);
    const elev = upper.clone().normalize().y;
    sv.shrug(side, Math.max(0, elev + 0.3) * 0.2, 0);
    sv.aim(`${side}Arm`, upper);
    sv.aim(`${side}ForeArm`, fore);

    // Колдун багыты: билек(0) → ортоңку MCP(9), алакан нормалы сөөмөй(5)/чыпалак(17) MCP аркылуу
    const w0 = P(hand, 0, new THREE.Vector3());
    const F = P(hand, 9, new THREE.Vector3()).sub(w0);
    const S = P(hand, 5, new THREE.Vector3()).sub(P(hand, 17, _v3));
    F.normalize();
    S.addScaledVector(F, -S.dot(F)).normalize();
    const N = side === "Left" ? new THREE.Vector3().crossVectors(F, S) : new THREE.Vector3().crossVectors(S, F);
    sv.orientHand(side, F, N);
    sv.distributeForearmTwist(side, 0.6);

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const f of FINGER_NAMES) {
      const ch = HAND_CHAINS[f];
      for (let k = 0; k < 3; k++) {
        P(hand, ch[k], a);
        P(hand, ch[k + 1], b);
        sv.aim(`${side}Hand${f}${k + 1}`, b.sub(a));
      }
    }
  }
}

/** Жазылган клиптин `tMs` убактысындагы кадрды (сызыктуу интерполяция менен) */
export function sampleMocapClip(clip: MocapClip, tMs: number): MocapFrame | null {
  const fr = clip.frames;
  if (!fr.length) return null;
  if (tMs <= fr[0].t) return fr[0];
  if (tMs >= fr[fr.length - 1].t) return fr[fr.length - 1];
  let lo = 0;
  let hi = fr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = fr[lo];
  const b = fr[hi];
  const u = (tMs - a.t) / Math.max(1e-3, b.t - a.t);
  const lerpPts = (p: Vec3[] | null, q: Vec3[] | null): Vec3[] | null => {
    if (!p || !q) return u < 0.5 ? p : q;
    const n = Math.min(p.length, q.length);
    const out: Vec3[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [p[i][0] + (q[i][0] - p[i][0]) * u, p[i][1] + (q[i][1] - p[i][1]) * u, p[i][2] + (q[i][2] - p[i][2]) * u];
    return out;
  };
  let face: Record<string, number> | null = null;
  if (a.face && b.face) {
    face = {};
    for (const k of Object.keys(a.face)) face[k] = a.face[k] + ((b.face[k] ?? a.face[k]) - a.face[k]) * u;
  } else face = u < 0.5 ? a.face : b.face;
  return { t: tMs, pose: lerpPts(a.pose, b.pose), leftHand: lerpPts(a.leftHand, b.leftHand), rightHand: lerpPts(a.rightHand, b.rightHand), face };
}

export function mocapDuration(clip: MocapClip): number {
  const fr = clip.frames;
  if (!fr.length) return 0;
  return Math.max(1, fr[fr.length - 1].t - fr[0].t);
}
