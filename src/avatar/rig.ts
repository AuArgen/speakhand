// Аватардын скелети (Mixamo аталыштары) + процедуралык "премиум манекен" денеси.
// Координаттар: аватар +z карайт, +x = аватардын СОЛ жагы, +y өйдө, метр.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { buildFace, isFaceKey, jawDisplacement, type FaceController, type FaceKey, type FaceState } from "./face";

export type Side = "Left" | "Right";
export const SIDES: readonly Side[] = ["Left", "Right"];
export const FINGER_NAMES = ["Thumb", "Index", "Middle", "Ring", "Pinky"] as const;
export type FingerName = (typeof FINGER_NAMES)[number];

/** Скелети бар ар кандай аватар (процедуралык же GLB) ушул интерфейс аркылуу колдонулат. */
export interface AvatarRig {
  /** Сахнага кошулуучу тамыр. Анын локалдык мейкиндиги = аватар мейкиндиги. */
  root: THREE.Object3D;
  /** Канондук аттар ("Hips", "LeftArm", "LeftHandIndex1" ...) → сөөк */
  bones: Map<string, THREE.Bone>;
  face: FaceController | null;
  kind: "procedural" | "glb";
  dispose(): void;
}

export const MIXAMO_PREFIX = "mixamorig";

/** "mixamorig:LeftArm", "mixamorig1LeftArm", "mixamorig_LeftArm" → "LeftArm" */
export function canonicalBoneName(name: string): string {
  return name.replace(/^mixamorig\d*[:_]?/i, "").replace(/^Armature[|_]/, "");
}

// ---------------------------------------------------------------------------
// Материалдар
// ---------------------------------------------------------------------------

export interface AvatarPalette {
  skin: number;
  sweater: number;
  sweaterSheen: number;
  trousers: number;
  hair: number;
  lips: number;
  iris: number;
}

export const DEFAULT_PALETTE: AvatarPalette = {
  skin: 0xd9a584,
  sweater: 0x24506a,
  sweaterSheen: 0x6f9fba,
  trousers: 0x272a33,
  hair: 0x2b201b,
  lips: 0xbf6f68,
  iris: 0x4a3122,
};

type ShaderParams = Parameters<THREE.Material["onBeforeCompile"]>[0];

/**
 * Тери үчүн "wrap lighting": жарык-көлөкө чеги жумшартылып, терминаторго жылуу (кан) түс кошулат —
 * арзан subsurface-scattering сезими. Диффузия гана өзгөрөт, спекуляр/көлөкө өзгөрбөйт.
 */
function skinWrapLighting(shader: ShaderParams): void {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const needle = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );";
  if (!chunk.includes(needle)) return; // башка three версиясы — өзгөртпөй калтырабыз
  const patched = chunk.replace(
    needle,
    `float rawNL = dot( geometryNormal, directLight.direction );
	float wrapNL = saturate( ( rawNL + 0.42 ) / 1.42 );
	wrapNL *= wrapNL * ( 3.0 - 2.0 * wrapNL ) * 0.5 + 0.5 * wrapNL;
	vec3 sssTint = mix( vec3( 1.0, 0.5, 0.4 ), vec3( 1.0 ), smoothstep( -0.42, 0.5, rawNL ) );
	vec3 wrapIrradiance = wrapNL * directLight.color * sssTint;
	#ifdef USE_SHEEN
		wrapIrradiance *= sheenEnergyComp;
	#endif
	reflectedLight.directDiffuse += wrapIrradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );`,
  );
  shader.fragmentShader = shader.fragmentShader.replace("#include <lights_physical_pars_fragment>", patched);
}

function makeMaterials(p: AvatarPalette) {
  const skin = new THREE.MeshPhysicalMaterial({
    color: p.skin,
    roughness: 0.58,
    metalness: 0,
    sheen: 0.35,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(0xffd2b8),
    clearcoat: 0.08,
    clearcoatRoughness: 0.7,
    specularIntensity: 0.55,
  });
  skin.onBeforeCompile = skinWrapLighting;
  const sweater = new THREE.MeshPhysicalMaterial({
    color: p.sweater,
    roughness: 0.82,
    sheen: 0.6,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(p.sweaterSheen),
  });
  const cuff = sweater.clone();
  cuff.color.multiplyScalar(0.82);
  const trousers = new THREE.MeshPhysicalMaterial({ color: p.trousers, roughness: 0.7, sheen: 0.4, sheenColor: new THREE.Color(0x5a6070) });
  const hair = new THREE.MeshPhysicalMaterial({
    color: p.hair,
    roughness: 0.46,
    sheen: 0.85,
    sheenRoughness: 0.32,
    sheenColor: new THREE.Color(0x7a5a48),
    side: THREE.DoubleSide,
  });
  const brows = new THREE.MeshStandardMaterial({ color: 0x241a15, roughness: 0.7 });
  const lips = new THREE.MeshPhysicalMaterial({ color: p.lips, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.4, sheen: 0.3, sheenColor: new THREE.Color(0xffb0a8) });
  lips.onBeforeCompile = skinWrapLighting;
  const nails = new THREE.MeshPhysicalMaterial({ color: 0xf0cdbd, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.15 });
  const eyeWhite = new THREE.MeshPhysicalMaterial({ color: 0xf6f3ee, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05 });
  const iris = new THREE.MeshPhysicalMaterial({ color: p.iris, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05 });
  const pupil = new THREE.MeshPhysicalMaterial({ color: 0x0a0a0c, roughness: 0.1, clearcoat: 1 });
  const polyOff = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 };
  const mouth = new THREE.MeshStandardMaterial({ color: 0x3d151b, roughness: 0.9, ...polyOff });
  const teeth = new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.35, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
  const tongue = new THREE.MeshPhysicalMaterial({ color: 0xb4524f, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.3 });
  const blush = skin.clone();
  blush.color.lerp(new THREE.Color(0xe79a8a), 0.16);
  blush.onBeforeCompile = skinWrapLighting;
  return { skin, sweater, cuff, trousers, hair, brows, lips, nails, eyeWhite, iris, pupil, mouth, teeth, tongue, blush };
}

// ---------------------------------------------------------------------------
// Геометрия жардамчылары
// ---------------------------------------------------------------------------

/** +y боюнча узундугу `len` болгон, учтары тоголок, жоондугу r0→r1 өзгөргөн капсула */
function taperedCapsule(r0: number, r1: number, len: number, radial = 20, capSeg = 8): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= capSeg; i++) {
    const a = -Math.PI / 2 + (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-5, Math.cos(a) * r0), Math.sin(a) * r0));
  }
  for (let i = 0; i <= capSeg; i++) {
    const a = (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-5, Math.cos(a) * r1), len + Math.sin(a) * r1));
  }
  return new THREE.LatheGeometry(pts, radial, Math.PI);
}

/**
 * Буттун/колдун бөлүгү: учтары тоголок, ортосунда (`tMid` жеринде) `rMid` радиустуу булчуң томпогу.
 * Профиль Catmull-Rom менен жылмакай.
 */
function limbGeometry(r0: number, rMid: number, r1: number, len: number, tMid = 0.4, radial = 24): THREE.BufferGeometry {
  const prof = profile([
    [0, r0],
    [len * tMid, rMid],
    [len, r1],
  ]);
  const pts: THREE.Vector2[] = [];
  const capSeg = 8;
  for (let i = 0; i < capSeg; i++) {
    const a = -Math.PI / 2 + (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-5, Math.cos(a) * r0), Math.sin(a) * r0));
  }
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const y = (len * i) / n;
    pts.push(new THREE.Vector2(Math.max(1e-5, prof(y)), y));
  }
  for (let i = 1; i <= capSeg; i++) {
    const a = (i / capSeg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-5, Math.cos(a) * r1), len + Math.sin(a) * r1));
  }
  return new THREE.LatheGeometry(pts, radial, Math.PI);
}

/**
 * a→b кесиндисине жайгашкан меш, кесилиш огу белгилүү: мештин локалдык +x огу `side` жакка
 * карайт (ошондо scale.x / scale.z менен эллипстик кесилиш берүүгө болот).
 */
function segmentOriented(geo: THREE.BufferGeometry, mat: THREE.Material, a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(a);
  const y = b.clone().sub(a).normalize();
  const x = side.clone().addScaledVector(y, -side.dot(y));
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0).addScaledVector(y, -y.x);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return m;
}

/** Catmull-Rom менен жылмакай профиль функциясы */
function profile(points: [number, number][]): (y: number) => number {
  return (y: number) => {
    if (y <= points[0][0]) return points[0][1];
    for (let i = 0; i < points.length - 1; i++) {
      const [y1, r1] = points[i];
      const [y2, r2] = points[i + 1];
      if (y <= y2) {
        const r0 = points[Math.max(0, i - 1)][1];
        const r3 = points[Math.min(points.length - 1, i + 2)][1];
        const t = (y - y1) / (y2 - y1);
        const t2 = t * t;
        const t3 = t2 * t;
        return 0.5 * (2 * r1 + (-r0 + r2) * t + (2 * r0 - 5 * r1 + 4 * r2 - r3) * t2 + (-r0 + 3 * r1 - 3 * r2 + r3) * t3);
      }
    }
    return points[points.length - 1][1];
  };
}

// Тулку (аватар мейкиндигиндеги y → жарым туурасы). Көкүрөк кенен, бел ичке, жогору жагы ийинге карай жайылат.
export const TORSO_R = profile([
  [0.78, 0.152],
  [0.86, 0.158],
  [0.94, 0.156],
  [1.01, 0.146],
  [1.07, 0.137],
  [1.15, 0.142],
  [1.23, 0.16],
  [1.31, 0.176],
  [1.38, 0.184],
  [1.43, 0.184],
  [1.47, 0.178],
  [1.5, 0.152],
  [1.52, 0.092],
  [1.535, 0.0],
]);
export const TORSO_DEPTH = profile([
  [0.78, 0.66],
  [0.95, 0.64],
  [1.07, 0.6],
  [1.25, 0.61],
  [1.38, 0.6],
  [1.5, 0.63],
  [1.535, 0.7],
]);

function torsoPiece(y0: number, y1: number, shrink = 1, flare = 0, tuck = 0): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  pts.push(new THREE.Vector2(1e-5, y0));
  const n = Math.max(6, Math.round((y1 - y0) / 0.01));
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    let r = TORSO_R(y) * shrink;
    if (flare > 0 && i <= 2) r += flare * (1 - i / 2);
    // Төмөнкү четин ичке тыгуу (кийинки бөлүктүн ичине жашырылат)
    if (tuck > 0 && y < y0 + tuck) r *= 0.9 + 0.1 * THREE.MathUtils.smoothstep(y, y0, y0 + tuck);
    pts.push(new THREE.Vector2(Math.max(1e-5, r), y));
  }
  if (TORSO_R(y1) > 0.005) pts.push(new THREE.Vector2(1e-5, y1));
  const g = new THREE.LatheGeometry(pts, 56, Math.PI);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const x = pos.getX(i);
    let z = pos.getZ(i) * TORSO_DEPTH(y);
    // Көкүрөк алдыга (эки көкүрөк булчуңу), арка түзүрөөк, курсак бир аз алдыга
    if (z > 0) {
      const pec = Math.exp(-(((y - 1.37) / 0.075) ** 2)) * (0.6 + 0.4 * Math.exp(-(((Math.abs(x) - 0.07) / 0.06) ** 2)));
      z *= 1 + 0.045 * pec + 0.015 * Math.exp(-(((y - 1.05) / 0.1) ** 2));
    } else z *= 0.92;
    pos.setZ(i, z + 0.004);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Процедуралык аватар
// ---------------------------------------------------------------------------

interface FingerSpec {
  name: FingerName;
  /** колдун кадр (F, S, N) координаттарында базасы */
  base: [number, number, number];
  dir: [number, number, number];
  lens: [number, number, number];
  radii: [number, number, number];
}

const FINGER_SPECS: FingerSpec[] = [
  { name: "Thumb", base: [0.022, 0.024, 0.01], dir: [0.6, 0.66, 0.45], lens: [0.036, 0.028, 0.023], radii: [0.0132, 0.0115, 0.0104] },
  { name: "Index", base: [0.092, 0.0275, 0], dir: [1, 0.035, 0], lens: [0.045, 0.027, 0.021], radii: [0.0098, 0.0091, 0.0085] },
  { name: "Middle", base: [0.096, 0.0065, 0], dir: [1, 0, 0], lens: [0.049, 0.03, 0.023], radii: [0.0101, 0.0094, 0.0087] },
  { name: "Ring", base: [0.092, -0.0135, 0], dir: [1, -0.04, 0], lens: [0.046, 0.028, 0.021], radii: [0.0095, 0.0088, 0.0082] },
  { name: "Pinky", base: [0.084, -0.032, 0], dir: [1, -0.09, 0], lens: [0.036, 0.022, 0.019], radii: [0.0085, 0.0079, 0.0074] },
];

export interface ProceduralOptions {
  palette?: Partial<AvatarPalette>;
}

export function createProceduralAvatar(opts: ProceduralOptions = {}): AvatarRig {
  const palette = { ...DEFAULT_PALETTE, ...opts.palette };
  const M = makeMaterials(palette);
  const geos: THREE.BufferGeometry[] = [];
  const G = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };

  const root = new THREE.Group();
  root.name = "AvatarRoot";
  const bones = new Map<string, THREE.Bone>();
  const restWorld = new Map<THREE.Bone, THREE.Vector3>();

  function bone(name: string, parent: THREE.Object3D, x: number, y: number, z: number): THREE.Bone {
    const b = new THREE.Bone();
    b.name = MIXAMO_PREFIX + name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.set(name, b);
    const pw = parent instanceof THREE.Bone ? restWorld.get(parent)! : new THREE.Vector3();
    restWorld.set(b, pw.clone().add(b.position));
    return b;
  }

  const shadowy = (m: THREE.Mesh, cast = true, receive = true) => {
    m.castShadow = cast;
    m.receiveShadow = receive;
    return m;
  };

  /** Аватар мейкиндигиндеги геометрияны сөөккө байлоо */
  function attachWorld(b: THREE.Bone, geo: THREE.BufferGeometry, mat: THREE.Material, cast = true): THREE.Mesh {
    const m = shadowy(new THREE.Mesh(geo, mat), cast);
    m.position.copy(restWorld.get(b)!).negate();
    b.add(m);
    return m;
  }

  // ---- Скелет ----
  const hips = bone("Hips", root, 0, 1.0, 0);
  const spine = bone("Spine", hips, 0, 0.1, 0);
  const spine1 = bone("Spine1", spine, 0, 0.12, 0);
  const spine2 = bone("Spine2", spine1, 0, 0.12, 0);
  const neck = bone("Neck", spine2, 0, 0.15, -0.006);
  const head = bone("Head", neck, 0, 0.07, 0.012);
  bone("HeadTop_End", head, 0, 0.22, 0);

  // ---- Тулку ----
  attachWorld(hips, G(torsoPiece(0.76, 0.975, 0.965)), M.trousers);
  attachWorld(spine, G(torsoPiece(0.93, 1.27, 0.99, 0.006)), M.sweater);
  attachWorld(spine2, G(torsoPiece(1.14, 1.535, 1, 0, 0.06)), M.sweater);
  // Жака
  const collarGeo = G(new THREE.TorusGeometry(0.06, 0.0085, 12, 48));
  collarGeo.rotateX(Math.PI / 2);
  const collar = shadowy(new THREE.Mesh(collarGeo, M.cuff));
  collar.scale.set(1, 1, 0.88);
  collar.position.set(0, 1.522 - 1.34, 0.004);
  spine2.add(collar);

  // ---- Моюн / Баш ----
  const neckGeo = G(taperedCapsule(0.056, 0.05, 0.11, 28, 6));
  const neckMesh = shadowy(new THREE.Mesh(neckGeo, M.skin));
  neckMesh.position.set(0, -0.025, 0.0);
  neckMesh.scale.set(1, 1, 1.08);
  neck.add(neckMesh);

  const headCenter = new THREE.Vector3(0, 0.1, 0.018);
  const headGroup = new THREE.Group();
  headGroup.position.copy(headCenter);
  head.add(headGroup);
  const headGeo = G(buildHeadGeometry());
  const headMesh = shadowy(new THREE.Mesh(headGeo, M.skin));
  headMesh.updateMorphTargets();
  headGroup.add(headMesh);

  // Беттин бети: z(x, y) — raycast менен
  const raycaster = new THREE.Raycaster();
  const tmpMesh = new THREE.Mesh(headGeo);
  tmpMesh.updateMatrixWorld(true);
  const zCache = new Map<string, number>();
  const surface = (x: number, y: number): number => {
    const key = `${x.toFixed(4)},${y.toFixed(4)}`;
    const c = zCache.get(key);
    if (c !== undefined) return c;
    raycaster.set(new THREE.Vector3(x, y, 0.5), new THREE.Vector3(0, 0, -1));
    const hit = raycaster.intersectObject(tmpMesh, false)[0];
    const z = hit ? hit.point.z : 0.06;
    zCache.set(key, z);
    return z;
  };

  // Кулактар
  const earGeo = G(new THREE.SphereGeometry(1, 20, 14));
  for (const sx of [1, -1]) {
    const ear = shadowy(new THREE.Mesh(earGeo, M.skin));
    ear.scale.set(0.011, 0.024, 0.016);
    ear.position.set(0.081 * sx, 0.002, -0.006);
    ear.rotation.set(0, sx * 0.35, sx * -0.08);
    headGroup.add(ear);
    const inner = new THREE.Mesh(earGeo, M.blush);
    inner.scale.set(0.006, 0.016, 0.01);
    inner.position.set(0.0045 * sx, 0, 0.002);
    ear.add(inner);
    inner.scale.divide(ear.scale).multiplyScalar(1);
    inner.position.divide(ear.scale);
  }

  // Чач
  const hairGeo = G(buildHairGeometry());
  headGroup.add(shadowy(new THREE.Mesh(hairGeo, M.hair)));

  const face = buildFace(
    headGroup,
    surface,
    {
      skin: M.skin,
      lips: M.lips,
      brows: M.brows,
      eyeWhite: M.eyeWhite,
      iris: M.iris,
      pupil: M.pupil,
      mouth: M.mouth,
      teeth: M.teeth,
      blush: M.blush,
      tongue: M.tongue,
    },
    headMesh,
  );

  // ---- Колдор ----
  for (const side of SIDES) {
    const s = side === "Left" ? 1 : -1;
    const shoulder = bone(`${side}Shoulder`, spine2, 0.03 * s, 0.105, -0.012);
    const arm = bone(`${side}Arm`, shoulder, 0.155 * s, 0.01, 0);
    const fore = bone(`${side}ForeArm`, arm, 0.27 * s, 0, 0);
    const hand = bone(`${side}Hand`, fore, 0.245 * s, 0, 0);

    const v = (x: number, y = 0, z = 0) => new THREE.Vector3(x * s, y, z);
    const FWD = new THREE.Vector3(0, 0, 1);

    // Ийин "жүгү" (трапеция) — моюндан ийинге карай ылдый жантаят
    const trap = shadowy(segmentOriented(G(limbGeometry(0.058, 0.056, 0.05, 0.15, 0.35, 22)), M.sweater, v(-0.012, 0.028, -0.008), v(0.142, -0.004, 0.0), FWD));
    trap.scale.set(1.1, 1, 0.92);
    shoulder.add(trap);
    // Дельта булчуңу (ийин сферасы) — бир аз сүйрү
    const delt = shadowy(new THREE.Mesh(G(new THREE.SphereGeometry(0.056, 28, 20)), M.sweater));
    delt.position.copy(v(0.004, -0.004, 0));
    delt.scale.set(1, 1.12, 0.94);
    arm.add(delt);
    // Билек (жең): бицепс томпогу бар, кесилиши сүйрү
    const upper = shadowy(segmentOriented(G(limbGeometry(0.052, 0.05, 0.04, 0.27, 0.42)), M.sweater, v(0), v(0.27), FWD));
    upper.scale.set(0.94, 1, 1.0);
    arm.add(upper);
    // Чыканак + алакан жеңи: чыканакка жакын жоон, билекке карай ичкерет
    const foreMesh = shadowy(segmentOriented(G(limbGeometry(0.041, 0.043, 0.031, 0.19, 0.25)), M.sweater, v(0), v(0.19), FWD));
    foreMesh.scale.set(0.95, 1, 1.0);
    fore.add(foreMesh);
    const cuffGeo = G(taperedCapsule(0.0345, 0.033, 0.03, 24, 4));
    const cuff = shadowy(segmentOriented(cuffGeo, M.cuff, v(0.178), v(0.212), FWD));
    cuff.scale.set(0.95, 1, 1.0);
    fore.add(cuff);
    // Билектин бети (тери): жалпак — S (z) боюнча кенен, N (y) боюнча ичке
    const wrist = shadowy(segmentOriented(G(taperedCapsule(0.0285, 0.0265, 0.06, 20, 6)), M.skin, v(0.19), v(0.25), FWD));
    wrist.scale.set(1.08, 1, 0.8);
    fore.add(wrist);

    buildHand(hand, side, s);
  }

  function buildHand(hand: THREE.Bone, side: Side, s: number) {
    // Колдун кадры (тынч абалда): F = манжалар, S = сөөмөй жагы, N = алакан караган жак
    const F = new THREE.Vector3(s, 0, 0);
    const S = new THREE.Vector3(0, 0, 1);
    const N = new THREE.Vector3(0, -1, 0);
    const P = (f: number, sv: number, n: number) => F.clone().multiplyScalar(f).addScaledVector(S, sv).addScaledVector(N, n);

    // Алакан: тегеректелген куту, билекке карай ичкерет
    // Оң колдо (F, −N, S) базиси сол-колдуу болуп калат — анда геометриянын z огун −S деп алабыз
    const flip = new THREE.Matrix4().makeBasis(F, N.clone().negate(), S).determinant() < 0;
    const sSign = flip ? -1 : 1;
    const PALM_LEN = 0.094;
    const PALM_T = 0.027;
    const palmGeo = G(new RoundedBoxGeometry(PALM_LEN, PALM_T, 0.08, 9, 0.0125));
    const pp = palmGeo.getAttribute("position") as THREE.BufferAttribute;
    const g2 = (a: number, w: number) => Math.exp(-((a / w) ** 2));
    const MCP_S = [0.0275, 0.0065, -0.0135, -0.032];
    for (let i = 0; i < pp.count; i++) {
      const x = pp.getX(i); // F (-0.047..0.047)
      let y = pp.getY(i); // калыңдык: −y = алакан (N), +y = колдун сырты
      let z = pp.getZ(i); // ±S
      const t = (x + PALM_LEN / 2) / PALM_LEN; // 0 = билек, 1 = муундар
      // Билекке карай ичкерүү, муундарда кененирээк
      z *= 0.7 + 0.3 * Math.min(1, t * 1.45);
      const zs = z * sSign; // чыныгы S координатасы
      // Чыпалак жагы бир аз кыска
      let xx = x;
      if (x > 0.02) xx -= (0.5 - zs / 0.08) * 0.006 * ((x - 0.02) / 0.027);
      const depth = Math.abs(y) / (PALM_T / 2); // 0 = орто тегиздик, 1 = бет
      if (y < 0) {
        // Алакан бети: тенар (бармак түбү), гипотенар (чыпалак жагы) томпоктору, ортосу чуңкур
        const thenar = 0.0105 * g2(t - 0.32, 0.3) * g2(zs - 0.027, 0.024);
        const hypo = 0.0065 * g2(t - 0.45, 0.32) * g2(zs + 0.03, 0.02);
        const hollow = -0.003 * g2(t - 0.55, 0.26) * g2(zs, 0.018);
        const heel = 0.003 * g2(t - 0.12, 0.14);
        y -= (thenar + hypo + hollow + heel) * depth;
        // Билек четинде жукарат
        y *= 0.9 + 0.1 * Math.min(1, t * 3);
      } else {
        // Колдун сырты: ортосу томпок, муундарга карай жукарат, манжа түбүндө муун чокулары
        y *= (0.88 + 0.24 * (1 - Math.abs(z) / 0.045)) * (1 - 0.18 * t);
        let knuckle = 0;
        for (const ms of MCP_S) knuckle += 0.0024 * g2(zs - ms, 0.0085) * g2(t - 0.96, 0.09);
        y += knuckle * depth;
      }
      pp.setXYZ(i, xx, y, z);
    }
    palmGeo.computeVertexNormals();
    const palm = shadowy(new THREE.Mesh(palmGeo, M.skin));
    // Геометриянын x → F, -y → N (y → -N = +y), z → S
    const basis = new THREE.Matrix4().makeBasis(F, N.clone().negate(), S.clone().multiplyScalar(sSign));
    palm.quaternion.setFromRotationMatrix(basis);
    palm.position.copy(P(0.05, 0.0, 0.002));
    hand.add(palm);

    for (const spec of FINGER_SPECS) {
      const base = P(spec.base[0], spec.base[1], spec.base[2]);
      const dir = P(spec.dir[0], spec.dir[1], spec.dir[2]).normalize();
      let parent: THREE.Bone = hand;
      let jointLocal = base.clone();
      const chain: THREE.Bone[] = [];
      for (let k = 0; k < 4; k++) {
        const b = bone(`${side}Hand${spec.name}${k + 1}`, parent, jointLocal.x, jointLocal.y, jointLocal.z);
        chain.push(b);
        parent = b;
        if (k < 3) jointLocal = dir.clone().multiplyScalar(spec.lens[k]);
      }
      const isThumb = spec.name === "Thumb";
      // Фаланга мештери: кесилиши бир аз сүйрү (S боюнча кененирээк), учу ичкерет
      for (let k = 0; k < 3; k++) {
        const len = spec.lens[k];
        const r0 = spec.radii[k];
        const r1 = k < 2 ? spec.radii[k + 1] : spec.radii[2] * 0.8;
        const geo = G(taperedCapsule(r0, r1, len, 16, 6));
        const m = shadowy(segmentOriented(geo, M.skin, new THREE.Vector3(), dir.clone().multiplyScalar(len), S));
        m.scale.set(1.05, 1, isThumb ? 0.98 : 0.93);
        chain[k].add(m);
        if (k === 2) {
          // Тырмак: колдун сыртында (−N)
          const nail = new THREE.Mesh(G(new THREE.SphereGeometry(1, 14, 10)), M.nails);
          // Тырмак колдун сыртында (манжаларда −N, бармакта S−N жакка)
          const dorsal = isThumb ? S.clone().multiplyScalar(0.75).addScaledVector(N, -0.66) : N.clone().negate();
          dorsal.addScaledVector(dir, -dorsal.dot(dir)).normalize();
          const nx = new THREE.Vector3().crossVectors(dir, dorsal).normalize();
          const nb = new THREE.Matrix4().makeBasis(nx, dir, new THREE.Vector3().crossVectors(nx, dir));
          nail.quaternion.setFromRotationMatrix(nb);
          nail.scale.set(r1 * 0.82, len * 0.4, r1 * 0.3);
          nail.position.copy(dir.clone().multiplyScalar(len * 0.7)).addScaledVector(dorsal, r1 * 0.74);
          chain[k].add(nail);
        }
        if (k > 0) {
          // Муун: бүгүлгөндө арткы жагы чыгат — сфера бир аз −N жакка жылдырылган
          const j = shadowy(new THREE.Mesh(G(new THREE.SphereGeometry(r0 * 1.0, 14, 10)), M.skin));
          j.scale.set(1.04, 1, 0.98);
          j.position.addScaledVector(N, -0.0008);
          chain[k].add(j);
        }
      }
      if (!isThumb) {
        // Муштум муундары (MCP): колдун сыртында гана бир аз томпок
        const k = shadowy(new THREE.Mesh(G(new THREE.SphereGeometry(spec.radii[0] * 1.04, 16, 12)), M.skin));
        k.position.addScaledVector(N, -0.002).addScaledVector(dir, 0.001);
        k.scale.set(1.06, 1, 1);
        chain[0].add(k);
      }
    }
  }

  root.updateMatrixWorld(true);

  return {
    root,
    bones,
    face,
    kind: "procedural",
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of Object.values(M)) m.dispose();
      face.dispose();
      root.removeFromParent();
    },
  };
}

function deformHead(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  let X = x * 0.083;
  const Y = y * 0.112;
  let Z = z * 0.095;
  if (y < 0) {
    const k = Math.pow(-y, 1.5);
    X *= 1 - 0.3 * k;
    Z *= 1 - (z < 0 ? 0.32 : 0.1) * k;
    // ээк алдыга
    if (z > 0) Z += 0.01 * Math.pow(Math.max(0, -y - 0.55) / 0.45, 1.2) * z;
  }
  if (y > 0.1) X *= 1 + 0.035 * y;
  // бети бир аз жалпак
  if (z > 0) Z *= 1 - 0.05 * Math.pow(z, 4);
  // желке
  if (z < 0 && y > -0.3) Z *= 1 + 0.07 * Math.min(1, (y + 0.3) / 0.6);
  // жаак сөөктөрү
  const cheek = Math.exp(-(((y + 0.15) / 0.25) ** 2)) * Math.exp(-(((Math.abs(x) - 0.6) / 0.3) ** 2)) * Math.max(0, z);
  X *= 1 + 0.04 * cheek;
  Z *= 1 + 0.03 * cheek;
  // көз чуңкуру
  const socket = Math.exp(-(((y - 0.12) / 0.14) ** 2)) * Math.exp(-(((Math.abs(x) - 0.4) / 0.16) ** 2)) * Math.max(0, z);
  Z *= 1 - 0.035 * socket;
  return out.set(X, Y, Z);
}

/** Стилдештирилген баш: деформацияланган сфера (баштын борборуна салыштырмалуу) + "jawOpen" morph target */
function buildHeadGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 96, 72);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const d = new THREE.Vector3();
  const jaw = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    deformHead(pos.getX(i), pos.getY(i), pos.getZ(i), v);
    pos.setXYZ(i, v.x, v.y, v.z);
    jawDisplacement(v.x, v.y, v.z, d);
    jaw[i * 3] = v.x + d.x;
    jaw[i * 3 + 1] = v.y + d.y;
    jaw[i * 3 + 2] = v.z + d.z;
  }
  g.computeVertexNormals();
  g.morphAttributes.position = [new THREE.Float32BufferAttribute(jaw, 3)];
  g.morphTargetsRelative = false;
  return g;
}

/**
 * Кыска чач: баштын үстүңкү/арткы бөлүгүн жапкан кабык. Тор чач сызыгына ылайыкташып
 * курулат (ар бир узундук тилкеси уюлдан чач сызыгына чейин) — чети жылмакай болот.
 */
function buildHairGeometry(): THREE.BufferGeometry {
  const COLS = 128;
  const ROWS = 40;
  const hairline = (phi: number) => {
    const x = Math.sin(phi);
    const z = Math.cos(phi);
    let line = z > 0 ? 0.28 + 0.42 * z * z - 0.12 * Math.abs(x) * z : 0.28 + 0.72 * z;
    if (z > 0.3) line += 0.05 * Math.sin(x * 3.0 + 0.7) * z; // тарак жагы
    return line;
  };
  const positions: number[] = [];
  const index: number[] = [];
  const v = new THREE.Vector3();
  for (let j = 0; j <= COLS; j++) {
    const phi = (j / COLS) * Math.PI * 2;
    const lat1 = Math.asin(THREE.MathUtils.clamp(hairline(phi), -0.95, 0.95));
    for (let i = 0; i <= ROWS; i++) {
      const t = i / ROWS;
      const lat = THREE.MathUtils.lerp(Math.PI / 2, lat1, t);
      const ux = Math.cos(lat) * Math.sin(phi);
      const uy = Math.sin(lat);
      const uz = Math.cos(lat) * Math.cos(phi);
      deformHead(ux, uy, uz, v);
      // калыңдык: үстүндө көлөмдүү, четинде ичкерет
      const edge = 1 - THREE.MathUtils.smoothstep(t, 0.82, 1);
      const thick = (0.0025 + (0.004 + 0.0075 * Math.max(0, uy) + 0.002 * Math.max(0, -uz)) * edge) * 1;
      const len = v.length();
      v.multiplyScalar((len + thick) / len);
      positions.push(v.x, v.y, v.z);
    }
  }
  for (let j = 0; j < COLS; j++) {
    for (let i = 0; i < ROWS; i++) {
      const a = j * (ROWS + 1) + i;
      const b = (j + 1) * (ROWS + 1) + i;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setIndex(index);
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------------------
// GLB (Mixamo аталыштуу сөөктөр) жүктөө
// ---------------------------------------------------------------------------

/** Демейки реалисттик аватар (Blender/MPFB'ден экспорттолгон, public/models/avatar.glb) */
export const DEFAULT_AVATAR_URL = "/models/avatar.glb";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const _fe = new THREE.Euler();
const _fq = new THREE.Quaternion();
const _fp = new THREE.Quaternion();
const _fr = new THREE.Quaternion();

/**
 * GLB бети: ARKit аталыштуу morph target'тер (бардык мештерде — тери, каш, кирпик, тиш, тил...)
 * + көз сөөктөрү ("LeftEye"/"RightEye", баш сөөгүнүн баласы) менен көз карашы.
 */
class GLBFace implements FaceController {
  private targets: { mesh: THREE.Mesh; map: [number, FaceKey][] }[] = [];
  private eyes: { bone: THREE.Bone; restLocal: THREE.Quaternion }[] = [];
  constructor(
    private root: THREE.Object3D,
    bones: Map<string, THREE.Bone>,
  ) {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.morphTargetDictionary && m.morphTargetInfluences) {
        const map: [number, FaceKey][] = [];
        for (const [name, idx] of Object.entries(m.morphTargetDictionary)) if (isFaceKey(name)) map.push([idx, name]);
        if (map.length) this.targets.push({ mesh: m, map });
      }
    });
    for (const n of ["LeftEye", "RightEye"]) {
      const b = bones.get(n);
      if (b) this.eyes.push({ bone: b, restLocal: b.quaternion.clone() });
    }
  }
  get empty() {
    return this.targets.length === 0 && this.eyes.length === 0;
  }
  apply(s: FaceState): void {
    for (const { mesh, map } of this.targets) {
      const inf = mesh.morphTargetInfluences!;
      for (const [idx, key] of map) inf[idx] = clamp01(s[key]);
    }
    if (!this.eyes.length) return;
    // Караш: аватар мейкиндигинде yaw (+ = аватардын солу, +x) жана pitch (+ = өйдө)
    const yaw = THREE.MathUtils.clamp(s.eyeLookX, -1, 1) * 0.35;
    const pitch = -THREE.MathUtils.clamp(s.eyeLookY, -1, 1) * 0.25;
    _fe.set(pitch, yaw, 0, "YXZ");
    const rootQ = this.root.getWorldQuaternion(_fr);
    const R = _fq.setFromEuler(_fe).premultiply(rootQ).multiply(_fp.copy(rootQ).invert()); // дүйнөлүк мейкиндикке
    for (const { bone, restLocal } of this.eyes) {
      // local = parent⁻¹ · R · parent · rest  (сөөк ата-кадрынын ичинде дүйнөлүк октор боюнча бурулат)
      const parentQ = bone.parent!.getWorldQuaternion(_fp);
      bone.quaternion.copy(parentQ).invert().multiply(R).multiply(parentQ).multiply(restLocal);
    }
  }
  dispose(): void {
    this.targets = [];
    this.eyes = [];
  }
}

type PhysicalParams = THREE.MeshPhysicalMaterialParameters & { wrap?: boolean };

/** GLB'ден келген стандарт материалды физикалык материалга (тери/көз/чач ж.б. тууралоолору менен) айландыруу */
function toPhysical(src: THREE.MeshStandardMaterial, extra: PhysicalParams): THREE.MeshPhysicalMaterial {
  const { wrap, ...params } = extra;
  const base: THREE.MeshPhysicalMaterialParameters = {
    name: src.name,
    color: src.color,
    map: src.map,
    normalMap: src.normalMap,
    normalScale: src.normalScale,
    roughness: src.roughness,
    metalness: 0,
    side: src.side,
    transparent: false,
  };
  const all = { ...base, ...params } as Record<string, unknown>;
  for (const k of Object.keys(all)) if (all[k] === undefined || all[k] === null) delete all[k];
  const m = new THREE.MeshPhysicalMaterial(all as THREE.MeshPhysicalMaterialParameters);
  if (wrap) m.onBeforeCompile = skinWrapLighting;
  for (const t of [m.map, m.normalMap]) if (t) t.anisotropy = 8;
  return m;
}

/** Материал аты боюнча (Blender'деги аттар: skin, eyes, hair, eyebrows, eyelashes, teeth, tongue, sweater, trousers, shoes) */
function tuneGLBMaterial(src: THREE.MeshStandardMaterial): THREE.Material {
  const name = src.name.toLowerCase();
  const cutout = (alphaTest: number, extra: PhysicalParams = {}) =>
    toPhysical(src, { alphaTest, alphaToCoverage: true, side: THREE.DoubleSide, depthWrite: true, ...extra });
  if (name.includes("skin"))
    return toPhysical(src, {
      roughness: 0.52,
      sheen: 0.3,
      sheenRoughness: 0.65,
      sheenColor: new THREE.Color(0xffd2b8),
      clearcoat: 0.05,
      clearcoatRoughness: 0.7,
      specularIntensity: 0.45,
      envMapIntensity: 0.8,
      normalScale: new THREE.Vector2(0.55, 0.55),
      wrap: true,
    });
  if (name.includes("eye") && !name.includes("brow") && !name.includes("lash"))
    // Текстуранын альфасы чел кабыкты (cornea) кесет — көз алмасынын өзү жылтырак
    return toPhysical(src, {
      alphaTest: 0.5,
      color: src.color.clone().multiplyScalar(0.86), // агы алыстан "жаркырабасын"
      roughness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      specularIntensity: 0.6,
      envMapIntensity: 0.55,
    });
  if (name.includes("hair"))
    // Alpha-to-coverage (MSAA): жумшак чач четтери, сорттоосуз жана хэш-чуусуз
    return toPhysical(src, {
      alphaTest: 0.08, // төмөн чек: чач сызыгынын сейрек учтары coverage менен жумшак өтөт
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      roughness: 0.62,
      sheen: 0.25,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0x6a4e3e),
      specularIntensity: 0.4,
      envMapIntensity: 0.4,
    });
  if (name.includes("brow")) return cutout(0.25, { roughness: 0.75, envMapIntensity: 0.4 });
  if (name.includes("lash")) return cutout(0.2, { roughness: 0.8, envMapIntensity: 0.3 });
  if (name.includes("teeth")) return toPhysical(src, { alphaTest: 0.5, roughness: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.2 });
  if (name.includes("tongue")) return toPhysical(src, { roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.3, wrap: true });
  // Кийимдин астындагы дене өчүрүлгөн — ички бети да тартылат (жака/жең ичинен фон көрүнбөсүн)
  if (name.includes("sweater") || name.includes("shirt") || name.includes("top"))
    return toPhysical(src, {
      roughness: 0.85,
      sheen: 0.5,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0x5e9aa6),
      normalScale: new THREE.Vector2(0.6, 0.6),
      side: THREE.DoubleSide,
    });
  if (name.includes("trouser") || name.includes("pant"))
    return toPhysical(src, { roughness: 0.8, sheen: 0.3, sheenColor: new THREE.Color(0x5a6070), side: THREE.DoubleSide });
  return toPhysical(src, { roughness: Math.max(0.4, src.roughness) });
}

/**
 * Mixamo аталыштуу сөөктөрү бар GLB/GLTF аватарын жүктөйт.
 * Модель +z карап, y өйдө болушу керек (Blender'ден стандарттуу экспорт).
 */
export async function loadGLBAvatar(url: string): Promise<AvatarRig> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = new THREE.Group();
  root.name = "AvatarRoot";
  root.add(gltf.scene);
  const bones = new Map<string, THREE.Bone>();
  const converted = new Map<THREE.Material, THREE.Material>();
  gltf.scene.traverse((o) => {
    // Скин сөөктөрү же (скинсиз экспорттолгон) Mixamo аталыштуу түйүндөр
    if ((o as THREE.Bone).isBone || /^mixamorig/i.test(o.name)) {
      const name = canonicalBoneName(o.name);
      if (!bones.has(name)) bones.set(name, o as THREE.Bone);
    }
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      const out = mats.map((mat) => {
        let c = converted.get(mat);
        if (!c) {
          c = (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial ? tuneGLBMaterial(mat as THREE.MeshStandardMaterial) : mat;
          if (c !== mat) mat.dispose();
          converted.set(mat, c);
        }
        return c;
      });
      m.material = Array.isArray(m.material) ? out : out[0];
    }
  });
  const required = ["Hips", "Spine", "Neck", "Head", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand"];
  const missing = required.filter((n) => !bones.has(n));
  if (missing.length) throw new Error(`GLB аватарда сөөктөр жок: ${missing.join(", ")}`);
  const face = new GLBFace(root, bones);
  root.updateMatrixWorld(true);
  return {
    root,
    bones,
    face: face.empty ? null : face,
    kind: "glb",
    dispose() {
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
            mat.dispose();
          }
        }
      });
      root.removeFromParent();
    },
  };
}
