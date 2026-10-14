// Процедуралык бет: көздөр (ирмөө), каштар, ооз (ачуу/жылмаюу/бүрүү), жаактар.
// Бардык мимика FaceState аркылуу башкарылат (ARKit/MediaPipe blendshape аттары).
import * as THREE from "three";

export const FACE_KEYS = [
  "browInnerUp",
  "browDownLeft",
  "browDownRight",
  "browOuterUpLeft",
  "browOuterUpRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawOpen",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthPucker",
  "mouthFunnel",
  "cheekPuff",
  /** -1..1, + = аватардын сол жагына (экранда оңго) карайт */
  "eyeLookX",
  /** -1..1, + = өйдө */
  "eyeLookY",
] as const;

export type FaceKey = (typeof FACE_KEYS)[number];
export type FaceState = Record<FaceKey, number>;

export function neutralFace(): FaceState {
  const f = {} as FaceState;
  for (const k of FACE_KEYS) f[k] = 0;
  return f;
}

export function isFaceKey(k: string): k is FaceKey {
  return (FACE_KEYS as readonly string[]).includes(k);
}

export interface FaceController {
  apply(s: FaceState): void;
  dispose(): void;
}

export interface FaceMaterials {
  skin: THREE.Material;
  lips: THREE.Material;
  brows: THREE.Material;
  eyeWhite: THREE.Material;
  iris: THREE.Material;
  pupil: THREE.Material;
  mouth: THREE.Material;
  teeth: THREE.Material;
  blush: THREE.Material;
  tongue?: THREE.Material;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Жаак ачылышы: кулактын алдындагы огунун айланасында ылдый-артка бурулат (jawOpen = 1 үчүн).
const JAW_PIVOT_Y = -0.005;
const JAW_PIVOT_Z = -0.035;
const JAW_ANGLE = 0.24;

/**
 * Баштын борборуна салыштырмалуу (метр) чекиттин jawOpen=1 болгондогу жылышы.
 * Ооздун астындагы бет (ээк, астыңкы эрин) ылдый жана бир аз артка кетет; кулактын арты кыймылдабайт.
 */
export function jawDisplacement(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  // Эриндердин ортосу ≈ y = −0.054: үстүңкү эрин кыймылдабайт, астыңкы эринден төмөн толук жылат
  let w = 1 - THREE.MathUtils.smoothstep(y, -0.073, -0.055);
  w *= THREE.MathUtils.smoothstep(z, -0.06, -0.005);
  // Четтери (жаак бурчтары) бир аз азыраак
  w *= 1 - 0.25 * THREE.MathUtils.smoothstep(Math.abs(x), 0.045, 0.08);
  if (w <= 0) return out.set(0, 0, 0);
  const a = JAW_ANGLE * w;
  // Эриндердин ортосунда созулган тери тилкеси ооздун ичине (артка) кирет — көңдөй пайда болот
  const cavity = 0.02 * Math.sin(Math.PI * w) * Math.max(0, 1 - Math.abs(x) / 0.03);
  // Артка кетүү чыныгы жаакта азыраак (кондил жылат) — жарымы
  return out.set(0, -a * (z - JAW_PIVOT_Z), 0.5 * a * (y - JAW_PIVOT_Y) - cavity);
}

/**
 * `surface(x, y)` — баштын борборуна салыштырмалуу беттин алдыңкы z-координатасы.
 * `group` — баштын борборундагы топ; бардык бет бөлүктөрү ага кошулат.
 * `headMesh` — "jawOpen" morph target'и бар баш меши (болсо, ээк ачылат).
 */
export function buildFace(
  group: THREE.Object3D,
  surface: (x: number, y: number) => number,
  mats: FaceMaterials,
  headMesh?: THREE.Mesh,
): FaceController {
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(g: T): T => {
    disposables.push(g);
    return g;
  };

  // ---------- Көздөр ----------
  const EYE_R = 0.0158;
  const eyeY = 0.014;
  const eyeX = 0.035;
  const eyeballGeo = track(new THREE.SphereGeometry(EYE_R, 32, 24));
  const irisGeo = track(new THREE.SphereGeometry(EYE_R * 0.52, 24, 16));
  const pupilGeo = track(new THREE.SphereGeometry(EYE_R * 0.26, 16, 12));
  const glintGeo = track(new THREE.SphereGeometry(EYE_R * 0.085, 8, 6));
  const glintMat = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const lidR = EYE_R * 1.1;
  const upperLidGeo = track(new THREE.SphereGeometry(lidR, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2));
  const lowerLidGeo = track(new THREE.SphereGeometry(lidR, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2));
  const lashGeo = track(new THREE.TorusGeometry(lidR, 0.0013, 6, 32, Math.PI));
  lashGeo.rotateX(Math.PI / 2);
  const lowerLashGeo = track(new THREE.TorusGeometry(lidR, 0.0006, 6, 32, Math.PI));
  lowerLashGeo.rotateX(Math.PI / 2);

  interface Eye {
    ball: THREE.Group;
    upper: THREE.Group;
    lower: THREE.Group;
  }
  const eyes: Record<"L" | "R", Eye> = {} as Record<"L" | "R", Eye>;
  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const holder = new THREE.Group();
    const z = surface(eyeX * sx, eyeY) - EYE_R * 0.78;
    holder.position.set(eyeX * sx, eyeY, z);
    group.add(holder);

    const ball = new THREE.Group();
    holder.add(ball);
    const white = new THREE.Mesh(eyeballGeo, mats.eyeWhite);
    ball.add(white);
    const iris = new THREE.Mesh(irisGeo, mats.iris);
    iris.scale.set(1, 1, 0.38);
    iris.position.z = EYE_R * 0.86;
    ball.add(iris);
    const pupil = new THREE.Mesh(pupilGeo, mats.pupil);
    pupil.scale.set(1, 1, 0.35);
    pupil.position.z = EYE_R * 1.0;
    ball.add(pupil);
    const glint = new THREE.Mesh(glintGeo, glintMat);
    glint.position.set(EYE_R * 0.2, EYE_R * 0.22, EYE_R * 1.02);
    ball.add(glint);

    const upper = new THREE.Group();
    const upperLid = new THREE.Mesh(upperLidGeo, mats.skin);
    upper.add(upperLid);
    const lash = new THREE.Mesh(lashGeo, mats.brows);
    upper.add(lash);
    holder.add(upper);

    const lower = new THREE.Group();
    const lowerLid = new THREE.Mesh(lowerLidGeo, mats.skin);
    lower.add(lowerLid);
    const lowerLash = new THREE.Mesh(lowerLashGeo, mats.brows);
    lowerLash.rotation.x = Math.PI; // ылдыйкы четке
    lower.add(lowerLash);
    holder.add(lower);
    // Көз ичке бир аз кыйшык (сырткы бурчу өйдө) — жандуураак
    holder.rotation.z = sx * 0.06;

    eyes[side] = { ball, upper, lower };
  }

  // ---------- Каштар ----------
  interface Brow {
    pivot: THREE.Group;
    baseY: number;
    baseX: number;
    sx: number;
  }
  const brows: Record<"L" | "R", Brow> = {} as Record<"L" | "R", Brow>;
  for (const side of ["L", "R"] as const) {
    const sx = side === "L" ? 1 : -1;
    const cx = 0.036 * sx;
    const cy = 0.05;
    const cz = surface(cx, cy) + 0.0022;
    const pts: THREE.Vector3[] = [];
    const N = 7;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1); // 0 = ички учу, 1 = сырткы
      const lx = (-0.015 + 0.031 * u) * sx;
      const arch = Math.sin(u * Math.PI) * 0.0042 - u * 0.0018;
      const ly = arch;
      const lz = surface(cx + lx, cy + ly) + 0.0022 - cz;
      pts.push(new THREE.Vector3(lx, ly, lz));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = track(new THREE.TubeGeometry(curve, 20, 0.0027, 8, false));
    // Учтарын ичкертүү
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i);
      // жакынкы ийри чекитин табуу (жөнөкөй: x боюнча)
      const u = clamp01((tmp.x * sx + 0.015) / 0.031);
      const thick = 1 - 0.55 * Math.pow(u, 2.2) + 0.15 * (1 - u);
      const c = curve.getPoint(u);
      tmp.sub(c).multiplyScalar(thick).add(c);
      tmp.y = c.y + (tmp.y - c.y) * 1.25;
      tmp.z = c.z + (tmp.z - c.z) * 0.6;
      pos.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mats.brows);
    const pivot = new THREE.Group();
    pivot.position.set(cx, cy, cz);
    pivot.add(mesh);
    group.add(pivot);
    brows[side] = { pivot, baseY: cy, baseX: cx, sx };
  }

  // ---------- Мурун ----------
  const noseGeo = track(new THREE.SphereGeometry(1, 24, 16));
  const noseBridge = new THREE.Mesh(noseGeo, mats.skin);
  noseBridge.scale.set(0.0075, 0.02, 0.0085);
  noseBridge.position.set(0, -0.006, surface(0, -0.006) - 0.004);
  noseBridge.rotation.x = -0.32;
  group.add(noseBridge);
  const noseTip = new THREE.Mesh(noseGeo, mats.skin);
  noseTip.scale.set(0.0088, 0.0075, 0.0085);
  noseTip.position.set(0, -0.022, surface(0, -0.022) + 0.004);
  group.add(noseTip);
  for (const sx of [1, -1]) {
    const wing = new THREE.Mesh(noseGeo, mats.skin);
    wing.scale.set(0.0052, 0.0048, 0.0055);
    wing.position.set(0.0078 * sx, -0.025, surface(0.0078 * sx, -0.025) - 0.0005);
    group.add(wing);
  }

  // ---------- Жаактар ----------
  const cheekGeo = track(new THREE.SphereGeometry(1, 24, 16));
  const cheeks: { mesh: THREE.Mesh; base: THREE.Vector3 }[] = [];
  for (const sx of [1, -1]) {
    const m = new THREE.Mesh(cheekGeo, mats.blush);
    const base = new THREE.Vector3(0.045 * sx, -0.03, surface(0.045 * sx, -0.03) - 0.0175);
    m.position.copy(base);
    m.scale.set(0.02, 0.018, 0.016);
    group.add(m);
    cheeks.push({ mesh: m, base });
  }

  // ---------- Ооз ----------
  const MY = -0.054;
  const mouthGroup = new THREE.Group();
  const mz0 = surface(0, MY);
  mouthGroup.position.set(0, MY, mz0);
  group.add(mouthGroup);
  // Ооздун аймагы үчүн бийиктик торчосу (анимацияда raycast жасабаш үчүн)
  const GX0 = -0.044, GY0 = -0.034, GSTEP = 0.004, GNX = 23, GNY = 18;
  const grid = new Float32Array(GNX * GNY);
  for (let j = 0; j < GNY; j++) for (let i = 0; i < GNX; i++) grid[j * GNX + i] = surface(GX0 + i * GSTEP, MY + GY0 + j * GSTEP) - mz0;
  const mouthSurf = (x: number, y: number) => {
    const fx = THREE.MathUtils.clamp((x - GX0) / GSTEP, 0, GNX - 1.001);
    const fy = THREE.MathUtils.clamp((y - GY0) / GSTEP, 0, GNY - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const a = grid[iy * GNX + ix], b = grid[iy * GNX + ix + 1];
    const c = grid[(iy + 1) * GNX + ix], d = grid[(iy + 1) * GNX + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const interiorMat = mats.mouth;
  const teethMat = mats.teeth;
  let upperMesh: THREE.Mesh | null = null;
  let lowerMesh: THREE.Mesh | null = null;
  let interiorMesh: THREE.Mesh | null = null;
  let teethMesh: THREE.Mesh | null = null;
  const cornerGeo = track(new THREE.SphereGeometry(1, 12, 8));
  const corners = [new THREE.Mesh(cornerGeo, mats.lips), new THREE.Mesh(cornerGeo, mats.lips)];
  for (const c of corners) mouthGroup.add(c);
  // Тил: ооз ачылганда астынан көрүнөт
  const tongueGeo = track(new THREE.SphereGeometry(1, 16, 10));
  const tongue = new THREE.Mesh(tongueGeo, mats.tongue ?? mats.lips);
  tongue.visible = false;
  tongue.renderOrder = 1;
  mouthGroup.add(tongue);

  const NS = 15;
  let lastKey = "";
  const _jd = new THREE.Vector3();
  /** Ооз тобундагы чекиттин jaw менен жылышы (баш борборуна которуп эсептелет) */
  const jawShift = (_x: number, y: number, z: number, jaw: number, out: THREE.Vector3) => {
    // Эрин ээк менен бирге жүрөт: жылышуу эринден бир аз төмөнүрөөк (толук салмактуу) жерден алынат,
    // капталдан (x = 0.05) — ооздун көңдөй түртүүсү эринге тийбеши үчүн
    jawDisplacement(0.05, MY + y - 0.014, mz0 + z, _jd);
    return out.set(_jd.x * jaw, _jd.y * jaw, _jd.z * jaw);
  };

  function rebuildMouth(s: FaceState) {
    const smileL = clamp01(s.mouthSmileLeft);
    const smileR = clamp01(s.mouthSmileRight);
    const frownL = clamp01(s.mouthFrownLeft);
    const frownR = clamp01(s.mouthFrownRight);
    const pucker = clamp01(s.mouthPucker);
    const funnel = clamp01(s.mouthFunnel);
    const jaw = clamp01(s.jawOpen);
    const key = [smileL, smileR, frownL, frownR, pucker, funnel, jaw].map((v) => v.toFixed(3)).join(",");
    if (key === lastKey) return;
    lastKey = key;

    const w = 0.0215 * (1 + 0.22 * (smileL + smileR) * 0.5 - 0.42 * pucker - 0.3 * funnel - 0.1 * jaw);
    const openU = 0.0022 * jaw + 0.0045 * funnel + 0.0012 * pucker;
    // Астыңкы эрин: өз ачылышы + ээк менен бирге түшөт (jawShift)
    const openL = 0.005 * jaw + 0.006 * funnel + 0.0016 * pucker;
    const fwd = 0.0065 * pucker + 0.004 * funnel;
    const cL = 0.0085 * smileL - 0.0075 * frownL;
    const cR = 0.0085 * smileR - 0.0075 * frownR;
    const up: THREE.Vector3[] = [];
    const lo: THREE.Vector3[] = [];
    const sh = new THREE.Vector3();
    for (let i = 0; i < NS; i++) {
      const u = -1 + (2 * i) / (NS - 1); // -1 = оң бурч (−x), +1 = сол бурч (+x)
      const x = u * w;
      const bell = 1 - u * u;
      const corner = u * u * (u > 0 ? cL : cR);
      const cupid = -0.0007 * Math.exp(-((u / 0.2) ** 2));
      const yU = corner + bell * (0.0006 + openU) + cupid;
      const yL = corner - bell * (0.0004 + openL);
      const zBump = 0.0022 * bell + fwd * Math.pow(bell, 0.6);
      up.push(new THREE.Vector3(x, yU, mouthSurf(x, yU) + 0.0012 + zBump));
      const zL = mouthSurf(x, yL) + 0.0012 + zBump * 1.1;
      // Астыңкы эрин ээк менен: бурчтарда азыраак (бурчтар үстүңкү эринге байланган)
      jawShift(x, yL - 0.004, zL, jaw * (0.35 + 0.65 * Math.pow(bell, 0.5)), sh);
      lo.push(new THREE.Vector3(x, yL + sh.y, zL + sh.z));
    }

    const lipScale = 1 + 0.45 * pucker + 0.2 * funnel;
    const upCurve = new THREE.CatmullRomCurve3(up);
    const loCurve = new THREE.CatmullRomCurve3(lo);
    const upGeo = new THREE.TubeGeometry(upCurve, 28, 0.0024 * lipScale, 8, false);
    const loGeo = new THREE.TubeGeometry(loCurve, 28, 0.0033 * lipScale, 8, false);
    shapeLip(upGeo, upCurve, 0.75);
    shapeLip(loGeo, loCurve, 0.8);
    if (!upperMesh) {
      upperMesh = new THREE.Mesh(upGeo, mats.lips);
      lowerMesh = new THREE.Mesh(loGeo, mats.lips);
      mouthGroup.add(upperMesh, lowerMesh!);
    } else {
      upperMesh.geometry.dispose();
      upperMesh.geometry = upGeo;
      lowerMesh!.geometry.dispose();
      lowerMesh!.geometry = loGeo;
    }
    corners[0].position.copy(up[0]).lerp(lo[0], 0.5);
    corners[1].position.copy(up[NS - 1]).lerp(lo[NS - 1], 0.5);
    for (const c of corners) c.scale.setScalar(0.0022 * lipScale);

    // Ооздун ичи жана тиштер
    const opening = openU + openL + 0.016 * jaw;
    const showInterior = opening > 0.0012;
    if (showInterior) {
      const pts: THREE.Vector2[] = [];
      for (const p of up) pts.push(new THREE.Vector2(p.x, p.y - 0.0008));
      for (let i = lo.length - 1; i >= 0; i--) pts.push(new THREE.Vector2(lo[i].x, lo[i].y + 0.0008));
      const g = new THREE.ShapeGeometry(new THREE.Shape(pts), 1);
      // Ичи: үстүңкү эриндин артынан астыңкы эриндин борборуна чейин, ортосу көңдөйгө ийилет
      const midI = Math.floor(NS / 2);
      const topY = up[midI].y;
      const botY = lo[midI].y;
      const lipBackZ = lo[midI].z - mouthSurf(lo[midI].x, lo[midI].y) - 0.0025;
      projectZ(g, 0, (y) => {
        const f = botY < topY - 1e-5 ? clamp01((topY - y) / (topY - botY)) : 0;
        return 0.0018 + (lipBackZ - 0.0018) * f - 0.006 * jaw * Math.sin(Math.PI * f);
      });
      // Тиштер: үстүңкү эриндин астында ичке тилке
      const tpts: THREE.Vector2[] = [];
      const tb: THREE.Vector2[] = [];
      for (let i = 2; i < NS - 2; i++) {
        const top = up[i].y - 0.0012;
        const bot = Math.max(lo[i].y + 0.0012, top - 0.0065);
        tpts.push(new THREE.Vector2(up[i].x * 0.97, top));
        tb.push(new THREE.Vector2(up[i].x * 0.97, Math.min(bot, top)));
      }
      tb.reverse();
      const tg = new THREE.ShapeGeometry(new THREE.Shape([...tpts, ...tb]), 1);
      projectZ(tg, 0.0028, () => -0.0012 * jaw);
      if (!interiorMesh) {
        interiorMesh = new THREE.Mesh(g, interiorMat);
        teethMesh = new THREE.Mesh(tg, teethMat);
        interiorMesh.renderOrder = 1;
        teethMesh.renderOrder = 2;
        mouthGroup.add(interiorMesh, teethMesh);
      } else {
        interiorMesh.geometry.dispose();
        interiorMesh.geometry = g;
        teethMesh!.geometry.dispose();
        teethMesh!.geometry = tg;
      }
      // Тил: астыңкы эриндин ичинде, ооз канчалык ачык болсо ошончолук көрүнөт
      const tv = clamp01((jaw - 0.2) / 0.5);
      tongue.visible = tv > 0.01;
      if (tongue.visible) {
        const loMid = lo[Math.floor(NS / 2)];
        tongue.position.set(0, loMid.y + 0.004, loMid.z - 0.0045);
        tongue.scale.set(0.011 * (0.7 + 0.3 * tv), 0.0035 * (0.6 + 0.4 * tv), 0.009);
      }
    } else tongue.visible = false;
    if (interiorMesh) interiorMesh.visible = showInterior;
    if (teethMesh) teethMesh.visible = showInterior;
  }

  function shapeLip(geo: THREE.TubeGeometry, curve: THREE.Curve<THREE.Vector3>, flatten: number) {
    // Эриндерди учтарына карай ичкертүү жана алдыга-артка бир аз жалпайтуу
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const tubular = geo.parameters.tubularSegments;
    const radial = geo.parameters.radialSegments;
    const v = new THREE.Vector3();
    for (let i = 0; i <= tubular; i++) {
      const t = i / tubular;
      const c = curve.getPointAt(t);
      const u = t * 2 - 1;
      const thick = 0.45 + 0.55 * (1 - u * u);
      for (let j = 0; j <= radial; j++) {
        const idx = i * (radial + 1) + j;
        v.fromBufferAttribute(pos, idx).sub(c);
        v.multiplyScalar(thick);
        v.z *= flatten;
        v.add(c);
        pos.setXYZ(idx, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  function projectZ(g: THREE.BufferGeometry, off: number, extra?: (y: number) => number) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      pos.setZ(i, mouthSurf(x, y) + off + (extra ? extra(y) : 0));
    }
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }

  // ---------- apply ----------
  function applyEye(side: "L" | "R", blinkRaw: number, squint: number, wide: number, lookX: number, lookY: number) {
    const e = eyes[side];
    const blink = clamp01(blinkRaw);
    const sq = clamp01(squint);
    const wd = clamp01(wide);
    // ички rim бийиктиги: −θ (радиан)
    const openUpper = -0.55 - 0.25 * wd + 0.25 * sq;
    const openLower = 0.74 - 0.38 * sq + 0.1 * wd;
    // Ылдыйкы кабак бир аз көтөрүлөт, үстүңкү аны жабат (rim бийиктиги = −θ)
    const lowerNow = THREE.MathUtils.lerp(openLower, openLower - 0.12, blink);
    e.lower.rotation.x = lowerNow;
    e.upper.rotation.x = THREE.MathUtils.lerp(openUpper, lowerNow + 0.08, blink);
    e.ball.rotation.y = THREE.MathUtils.clamp(lookX, -1, 1) * 0.35;
    e.ball.rotation.x = -THREE.MathUtils.clamp(lookY, -1, 1) * 0.25;
    // Караш ылдый болсо, кабак да бир аз түшөт
    e.upper.rotation.x += Math.max(0, -lookY) * 0.15 * (1 - blink);
  }

  function apply(s: FaceState) {
    applyEye("L", s.eyeBlinkLeft, s.eyeSquintLeft, s.eyeWideLeft, s.eyeLookX, s.eyeLookY);
    applyEye("R", s.eyeBlinkRight, s.eyeSquintRight, s.eyeWideRight, s.eyeLookX, s.eyeLookY);

    const inner = clamp01(s.browInnerUp);
    for (const side of ["L", "R"] as const) {
      const b = brows[side];
      const down = clamp01(side === "L" ? s.browDownLeft : s.browDownRight);
      const outer = clamp01(side === "L" ? s.browOuterUpLeft : s.browOuterUpRight);
      const raise = 0.0065 * inner + 0.0075 * outer - 0.0065 * down;
      b.pivot.position.y = b.baseY + raise;
      b.pivot.position.x = b.baseX - b.sx * 0.0045 * down;
      // ички учу өйдө = +tilt
      const tilt = 0.42 * inner - 0.22 * outer - 0.45 * down;
      b.pivot.rotation.z = -b.sx * tilt;
    }

    const smile = (clamp01(s.mouthSmileLeft) + clamp01(s.mouthSmileRight)) * 0.5;
    const puff = clamp01(s.cheekPuff);
    if (headMesh?.morphTargetInfluences) headMesh.morphTargetInfluences[0] = clamp01(s.jawOpen);
    for (const c of cheeks) {
      c.mesh.visible = puff > 0.02;
      c.mesh.position.set(c.base.x * (1 + 0.12 * puff), c.base.y + 0.004 * smile, c.base.z + 0.014 * puff);
      c.mesh.scale.set(0.02 * (1 + 0.35 * puff), 0.018 * (1 + 0.2 * puff), 0.016 * (1 + 0.6 * puff));
    }
    rebuildMouth(s);
  }

  apply(neutralFace());

  return {
    apply,
    dispose() {
      for (const d of disposables) d.dispose();
      for (const m of [upperMesh, lowerMesh, interiorMesh, teethMesh]) m?.geometry.dispose();
    },
  };
}
