// Аватарды визуалдык текшерүү үчүн dev барак (avatar-dev.html).
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { HandShape, HandTarget, KeyframeClip, MocapClip, MocapFrame, Vec3 } from "../lib/types";
import { AvatarStage, DEMO_SIGNS, fingerspellClip, type PlayItem } from "./index";
import { fingerSegmentDirs, HANDSHAPES, type V3 } from "./handshapes";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = new AvatarStage($("stage"));
(window as unknown as { stage: AvatarStage }).stage = stage;
const caption = $("caption");
let speed = 1;
let ctrl: AbortController | null = null;

async function play(items: PlayItem[]) {
  ctrl?.abort();
  ctrl = new AbortController();
  await stage.play(items, {
    speed,
    signal: ctrl.signal,
    onItemStart: (_i, it) => (caption.textContent = it.gloss),
  });
  caption.textContent = "";
}

for (const s of DEMO_SIGNS) {
  const b = document.createElement("button");
  b.textContent = s.gloss;
  b.onclick = () => play([{ gloss: s.gloss, clip: s.clip }]);
  $("signs").appendChild(b);
}
$("all").onclick = () => play(DEMO_SIGNS.map((s) => ({ gloss: s.gloss, clip: s.clip })));
$("stop").onclick = () => stage.stop();
$<HTMLInputElement>("speed").oninput = (e) => {
  speed = Number((e.target as HTMLInputElement).value);
  $("speedv").textContent = speed.toFixed(2);
};
$("fsgo").onclick = () => {
  const w = $<HTMLInputElement>("fs").value;
  play([{ gloss: w.toUpperCase(), clip: fingerspellClip(w) }]);
};
let dark = true;
$("theme").onclick = () => {
  dark = !dark;
  document.body.classList.toggle("light", !dark);
  stage.setTheme(dark ? "dark" : "light");
};

for (const shape of Object.keys(HANDSHAPES) as HandShape[]) {
  const b = document.createElement("button");
  b.textContent = shape;
  b.onclick = () => {
    const clip: KeyframeClip = {
      kind: "keyframe",
      duration: 4000,
      keys: [
        { at: 0, right: { pos: [-0.17, 0.5, 0.25], shape, palm: "fwd", fingers: "up" }, left: { pos: [0.17, 0.45, 0.25], shape, palm: "in", fingers: "fwd" } },
        { at: 1, right: { pos: [-0.17, 0.5, 0.25], shape, palm: "fwd", fingers: "up" }, left: { pos: [0.17, 0.45, 0.25], shape, palm: "in", fingers: "fwd" } },
      ],
    };
    play([{ gloss: shape, clip }]);
  };
  $("shapes").appendChild(b);
}

// ---------------------------------------------------------------------------
// Синтетикалык мокап. Координаттар аватар мейкиндигинде: +x = адамдын СОЛ жагы.
// ---------------------------------------------------------------------------

type V = [number, number, number];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const nrm = (a: V): V => scl(a, 1 / (Math.hypot(...a) || 1));
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Колдун 21 чекити: F = манжалар, N = алакан караган жак, curl 0..1 */
function synthHand(side: "L" | "R", F: V, N: V, curl: number): Vec3[] {
  F = nrm(F);
  N = nrm(N);
  const S = side === "L" ? cross(N, F) : cross(F, N);
  const W = (f: number, s: number, n: number): V => add(add(scl(F, f), scl(S, s)), scl(N, n));
  const pts: V[] = new Array(21);
  pts[0] = [0, 0, 0];
  const finger = (base: number, mcp: V, lens: number[], splay: number) => {
    const dirs = fingerSegmentDirs([1.45 * curl, 1.6 * curl, 0.9 * curl, splay * (1 - curl)]);
    let p: V = mcp;
    pts[base] = p;
    for (let k = 0; k < 3; k++) {
      const d: V3 = dirs[k];
      p = add(p, scl(W(d[0], d[1], d[2]), lens[k]));
      pts[base + k + 1] = p;
    }
  };
  finger(5, W(0.092, 0.027, 0), [0.045, 0.027, 0.021], 0.18);
  finger(9, W(0.096, 0.006, 0), [0.049, 0.03, 0.023], 0.02);
  finger(13, W(0.092, -0.014, 0), [0.046, 0.028, 0.021], -0.14);
  finger(17, W(0.084, -0.032, 0), [0.036, 0.022, 0.019], -0.3);
  // Бармак: ачык → алаканды кесип өтөт
  const open: V[] = [W(0.046, 0.058, 0.016), W(0.062, 0.088, 0.013), W(0.075, 0.113, 0.01)];
  const closed: V[] = [W(0.053, 0.045, 0.036), W(0.074, 0.03, 0.063), W(0.087, 0.006, 0.071)];
  pts[1] = W(0.024, 0.026, 0.01);
  for (let k = 0; k < 3; k++) pts[2 + k] = add(scl(open[k], 1 - curl), scl(closed[k], curl));
  // Колдун борборуна салыштырмалуу
  const c = scl(pts.reduce((a, b) => add(a, b), [0, 0, 0] as V), 1 / 21);
  return pts.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
}

function synthFrame(tMs: number, mode: "waveL" | "fistR"): MocapFrame {
  const t = tMs / 1000;
  const pose: Vec3[] = Array.from({ length: 33 }, () => [0, 0.3, 0]);
  const set = (i: number, v: V) => (pose[i] = v);
  const lS: V = [0.18, 0.5, 0];
  const rS: V = [-0.18, 0.5, 0];
  set(11, lS);
  set(12, rS);
  set(23, [0.1, 0, 0]);
  set(24, [-0.1, 0, 0]);
  set(0, [0.02 * Math.sin(t), 0.7, 0.1]);
  set(7, [0.075, 0.71, 0]);
  set(8, [-0.075, 0.71, 0]);
  let leftHand: Vec3[] | null = null;
  let rightHand: Vec3[] | null = null;
  const sw = Math.sin(t * 6);
  if (mode === "waveL") {
    // Адамдын СОЛ колу (+x) өйдө көтөрүлүп булгалайт
    const lE: V = add(lS, [0.22, 0.04, 0.06]);
    const lW: V = add(lE, [0.06 * sw, 0.24, 0.03]);
    set(13, lE);
    set(15, lW);
    set(14, add(rS, [-0.04, -0.27, 0.02]));
    set(16, add(rS, [-0.03, -0.52, 0.08]));
    const curl = Math.max(0, Math.sin(t * 0.9)) ** 4; // кээде муштум
    leftHand = synthHand("L", [0.25 * sw, 1, 0], [0, 0, 1], curl);
  } else {
    // Оң кол алдыда, муштум ↔ ачык алакан
    const rE: V = add(rS, [-0.04, -0.26, 0.05]);
    const rW: V = add(rE, [0.06, 0.08, 0.24]);
    set(14, rE);
    set(16, rW);
    set(13, add(lS, [0.04, -0.27, 0.02]));
    set(15, add(lS, [0.03, -0.52, 0.08]));
    const curl = 0.5 + 0.5 * Math.sin(t * 2.5);
    rightHand = synthHand("R", [0, 0.3, 1], [1, 0, 0], curl);
  }
  return {
    t: tMs,
    pose,
    leftHand,
    rightHand,
    face: { mouthSmileLeft: 0.5 + 0.3 * Math.sin(t), mouthSmileRight: 0.5 + 0.3 * Math.sin(t), browInnerUp: 0.3 + 0.3 * Math.sin(t * 1.3), jawOpen: Math.max(0, Math.sin(t * 2)) * 0.4 },
  };
}

let liveTimer = 0;
function startLive(mode: "waveL" | "fistR") {
  window.clearInterval(liveTimer);
  const t0 = performance.now();
  caption.textContent = mode === "waveL" ? "live: LEFT (+x) hand → screen RIGHT" : "live: right hand fist/open";
  liveTimer = window.setInterval(() => {
    const t = performance.now() - t0;
    // 3–4 с аралыгында кол жоголот → тынч абалга аралашуусу керек
    const f = synthFrame(t, mode);
    if (t % 8000 > 5000) {
      f.leftHand = null;
      f.rightHand = null;
    }
    stage.setLiveFrame(f);
  }, 33);
}
$("live").onclick = () => startLive("waveL");
$("liveR").onclick = () => startLive("fistR");
$("release").onclick = () => {
  window.clearInterval(liveTimer);
  stage.setLiveFrame(null);
  caption.textContent = "";
};
$("clip").onclick = () => {
  window.clearInterval(liveTimer);
  stage.setLiveFrame(null);
  const frames: MocapFrame[] = [];
  for (let t = 0; t <= 3000; t += 33) frames.push(synthFrame(t, "waveL"));
  const clip: MocapClip = { kind: "mocap", fps: 30, frames };
  play([{ gloss: "MOCAP", clip }]);
};

// Скриншот үчүн: жестти белгилүү бир учурда "тоңдуруу" (Playwright'тан чакырылат)
(window as unknown as { freeze: (gloss: string, tn: number) => void }).freeze = (gloss, tn) => {
  const s = DEMO_SIGNS.find((d) => d.gloss === gloss);
  const clip = s ? s.clip : fingerspellClip(gloss);
  if (!clip) return;
  void stage.play([{ gloss, clip }], { speed: 1e-6 });
  const pb = (stage as unknown as { playback: { t: number; rt: { duration: number; player?: { setEntry: (s: object, ms: number) => void } } } }).playback;
  pb.rt.player?.setEntry({}, 0); // тоңдурулган кадрда кирүү өткөөлү керек эмес
  pb.t = tn * pb.rt.duration;
  caption.textContent = `${gloss} @ ${tn}`;
  step(5, 0.1);
};

// ---------------------------------------------------------------------------
// Скриншот жардамчылары (Playwright'тан чакырылат): камера, контакт-барактар, өткөөл кадрлар
// ---------------------------------------------------------------------------

interface StageInternals {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  framing: { center: THREE.Vector3; height: number; width: number };
  homeOffset: THREE.Vector3;
  lastInteract: number;
  playback: { t: number; rt: { duration: number; player?: { setEntry: (s: object, ms: number) => void } } } | null;
  solver: { worldPos(name: string, out: THREE.Vector3): THREE.Vector3 };
  tick(dt: number, now: number): void;
}
const st = stage as unknown as StageInternals;
/** Сахнаны колго алып `n` кадр алдыга жылдыруу (rAF фондо токтоп калса да детерминдүү) */
function step(n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) st.tick(dt, performance.now());
}
const camDefaults = {
  minPolar: st.controls.minPolarAngle,
  maxPolar: st.controls.maxPolarAngle,
  minAz: st.controls.minAzimuthAngle,
  maxAz: st.controls.maxAzimuthAngle,
};

/** Камераны `target`ке `dist` аралыктан, `az` (градус, + = аватардын сол жагынан) жана `el` (градус, + = өйдөдөн) менен коёт */
function cam(target: [number, number, number], dist: number, az = 0, el = 0): void {
  const c = st.controls;
  st.lastInteract = Infinity; // автоматтык "үйгө кайтуу" өчүрүлөт
  c.minPolarAngle = 0;
  c.maxPolarAngle = Math.PI;
  c.minAzimuthAngle = -Infinity;
  c.maxAzimuthAngle = Infinity;
  c.minDistance = 0;
  c.maxDistance = Infinity;
  const a = THREE.MathUtils.degToRad(az);
  const e = THREE.MathUtils.degToRad(el);
  const t = new THREE.Vector3(...target);
  c.target.copy(t);
  st.camera.position.set(t.x + dist * Math.cos(e) * Math.sin(a), t.y + dist * Math.sin(e), t.z + dist * Math.cos(e) * Math.cos(a));
  st.camera.lookAt(t);
  c.update();
}
function camReset(): void {
  const c = st.controls;
  c.minPolarAngle = camDefaults.minPolar;
  c.maxPolarAngle = camDefaults.maxPolar;
  c.minAzimuthAngle = camDefaults.minAz;
  c.maxAzimuthAngle = camDefaults.maxAz;
  st.lastInteract = -1e9;
  cam(st.framing.center.toArray() as [number, number, number], st.homeOffset.length(), 0, Math.asin(st.homeOffset.y / st.homeOffset.length()) * (180 / Math.PI));
}

/** Рендер канвасынын ортосун (аспект = tw/th) барактын (col,row) клеткасына тартат */
function drawTile(g: CanvasRenderingContext2D, label: string, col: number, row: number, tw: number, th: number): void {
  st.renderer.render(st.scene, st.camera);
  const src = st.renderer.domElement;
  let sw = src.height * (tw / th);
  let sh = src.height;
  if (sw > src.width) {
    sw = src.width;
    sh = src.width * (th / tw);
  }
  g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, col * tw, row * th, tw, th);
  g.fillStyle = "rgba(0,0,0,0.45)";
  g.fillRect(col * tw, row * th, tw, 22);
  g.fillStyle = "#fff";
  g.font = "bold 14px sans-serif";
  g.fillText(label, col * tw + 6, row * th + 16);
}
function showSheet(out: HTMLCanvasElement): void {
  let img = document.getElementById("sheet") as HTMLImageElement | null;
  if (!img) {
    img = document.createElement("img");
    img.id = "sheet";
    img.style.cssText = "position:fixed;inset:0;width:100%;height:100%;object-fit:contain;z-index:10;background:#111";
    img.onclick = () => img!.remove();
    document.body.appendChild(img);
  }
  img.src = out.toDataURL();
}
function hideSheet(): void {
  document.getElementById("sheet")?.remove();
}
function makeSheet(cols: number, rows: number, tw: number, th: number) {
  const out = document.createElement("canvas");
  out.width = tw * cols;
  out.height = th * rows;
  const g = out.getContext("2d")!;
  g.fillStyle = "#1a1f3a";
  g.fillRect(0, 0, out.width, out.height);
  return { out, g };
}

/** Кол формасын тоңдуруу: оң кол (алакан алдыга, манжалар өйдө), сол кол (алакан ичке, манжалар алдыга) */
function freezeShape(shape: HandShape, palm: HandTarget["palm"] = "fwd", fingers: HandTarget["fingers"] = "up"): void {
  const clip: KeyframeClip = {
    kind: "keyframe",
    duration: 4000,
    keys: [
      { at: 0, right: { pos: [-0.17, 0.5, 0.25], shape, palm, fingers }, left: { pos: [0.17, 0.45, 0.25], shape, palm: "in", fingers: "fwd" } },
      { at: 1, right: { pos: [-0.17, 0.5, 0.25], shape, palm, fingers }, left: { pos: [0.17, 0.45, 0.25], shape, palm: "in", fingers: "fwd" } },
    ],
  };
  void stage.play([{ gloss: shape, clip }], { speed: 1e-6 });
  st.playback?.rt.player?.setEntry({}, 0); // тоңдурулган кадрда кирүү өткөөлү керек эмес
  caption.textContent = "";
  step(5, 0.1);
}

const SIGN_PEAKS: Record<string, number> = {
  САЛАМ: 0.42, РАХМАТ: 0.65, ООБА: 0.25, ЖОК: 0.4, МЕН: 0.35, СЕН: 0.4, ЖАКШЫ: 0.4, ЖАМАН: 0.55, СУУ: 0.72,
  ТАМАК: 0.3, КЕЛ: 0.4, БАР: 0.8, ҮЙ: 0.3, ДОС: 0.6, ЖАРДАМ: 0.85, СҮЙҮҮ: 0.75, КАНДАЙ: 0.5,
  ЭРТЕҢ: 0.7, БҮГҮН: 0.5, КЕЧЭЭ: 0.7, АТ: 0.45,
};

const freeze = (window as unknown as { freeze: (g: string, t: number) => void }).freeze;

const devApi = {
  cam,
  camReset,
  hideSheet,
  /** 12 кол формасы, оң колдун жакын планы; az = камеранын азимуту (0 = алдыдан, 45 = 3/4) */
  async shapeSheet(az = 0, el = 0, palm: HandTarget["palm"] = "fwd", fingers: HandTarget["fingers"] = "up"): Promise<void> {
    hideSheet();
    const shapes = Object.keys(HANDSHAPES) as HandShape[];
    const tw = 213;
    const th = 400;
    const { out, g } = makeSheet(6, 2, tw, th);
    for (let i = 0; i < shapes.length; i++) {
      freezeShape(shapes[i], palm, fingers);
      // Камера оң колдун чыныгы ордуна (риг боюнча): билек + манжалар жакка ~8 см
      const hp = st.solver.worldPos("RightHand", new THREE.Vector3());
      cam([hp.x, hp.y + 0.08, hp.z], 0.55, az, el);
      drawTile(g, `${shapes[i]} az${az}`, i % 6, Math.floor(i / 6), tw, th);
    }
    camReset();
    stage.stop();
    showSheet(out);
  },
  /** Бардык демо жесттер чокусунда (же берилген тизме) */
  async signSheet(list?: [string, number][], az = 0, cols = 6): Promise<void> {
    hideSheet();
    const items = list ?? DEMO_SIGNS.map((s) => [s.gloss, SIGN_PEAKS[s.gloss] ?? 0.5] as [string, number]);
    const tw = Math.floor(1280 / cols);
    const rows = Math.ceil(items.length / cols);
    const th = Math.floor(800 / rows);
    const { out, g } = makeSheet(cols, rows, tw, th);
    for (let i = 0; i < items.length; i++) {
      const [gloss, t] = items[i];
      freeze(gloss, t);
      cam([0, 1.35, 0], 2.0, az, 4);
      drawTile(g, `${gloss} @${t}`, i % cols, Math.floor(i / cols), tw, th);
    }
    camReset();
    stage.stop();
    showSheet(out);
  },
  /** A → B өткөөлү: B башталгандан −120..+520 мс аралыгындагы кадрлар (реалдуу убакыт) */
  async transitionSheet(a: string, b: string, az = 0, n = 8): Promise<void> {
    hideSheet();
    const A = DEMO_SIGNS.find((d) => d.gloss === a)!;
    const B = DEMO_SIGNS.find((d) => d.gloss === b)!;
    const tw = Math.floor(1280 / Math.ceil(n / 2));
    const th = 400;
    const { out, g } = makeSheet(Math.ceil(n / 2), 2, tw, th);
    cam([0, 1.35, 0], 2.0, az, 4);
    const frames: { t: number; img: ImageBitmap }[] = [];
    let switchAt = -1;
    let done = false;
    let simMs = 0;
    const src = st.renderer.domElement;
    // Симуляцияланган убакыт: ар бир кадр 1/60 с, rAF'ка көз каранды эмес
    const p = stage.play(
      [
        { gloss: a, clip: A.clip },
        { gloss: b, clip: B.clip },
      ],
      { speed: 1, onItemStart: (i) => (i === 1 ? (switchAt = simMs) : 0) },
    );
    void p.then(() => (done = true));
    for (let i = 0; i < 600 && !done; i++) {
      step(1, 1 / 60);
      simMs += 1000 / 60;
      await Promise.resolve();
      if (switchAt >= 0 && simMs > switchAt + 700) break;
      if (switchAt >= 0 || i > 0) {
        // Кичирейтилген кадрлар; өтүүгө чейин 30 кадр гана сакталат (GPU эсин толтурбоо үчүн)
        const bmp = await createImageBitmap(src, { resizeWidth: 640, resizeHeight: 400 });
        frames.push({ t: simMs, img: bmp });
        if (switchAt < 0 && frames.length > 30) frames.shift()!.img.close();
      }
    }
    stage.stop();
    if (switchAt < 0) switchAt = simMs;
    const picks: { t: number; img: ImageBitmap }[] = [];
    for (let i = 0; i < n; i++) {
      const target = switchAt - 120 + (640 * i) / (n - 1);
      let best = frames[0];
      for (const f of frames) if (Math.abs(f.t - target) < Math.abs(best.t - target)) best = f;
      picks.push(best);
    }
    picks.forEach((p, i) => {
      let sw = p.img.height * (tw / th);
      let sh = p.img.height;
      if (sw > p.img.width) {
        sw = p.img.width;
        sh = p.img.width * (th / tw);
      }
      const col = i % Math.ceil(n / 2);
      const row = Math.floor(i / Math.ceil(n / 2));
      g.drawImage(p.img, (p.img.width - sw) / 2, (p.img.height - sh) / 2, sw, sh, col * tw, row * th, tw, th);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(col * tw, row * th, tw, 22);
      g.fillStyle = "#fff";
      g.font = "bold 14px sans-serif";
      g.fillText(`${a}→${b} ${Math.round(p.t - switchAt)}ms az${az}`, col * tw + 6, row * th + 16);
    });
    for (const f of frames) f.img.close();
    camReset();
    showSheet(out);
  },
  /** Беттин жакын планы (сүйлөө оозу менен) */
  async faceShot(jaw = 0, az = 0): Promise<void> {
    hideSheet();
    const clip: KeyframeClip = {
      kind: "keyframe",
      duration: 4000,
      keys: [
        { at: 0, face: { jawOpen: jaw, ...(jaw > 0 ? { browInnerUp: 0.3 } : {}) } },
        { at: 1, face: { jawOpen: jaw } },
      ],
    };
    void stage.play([{ gloss: "face", clip }], { speed: 1e-6 });
    caption.textContent = "";
    step(5, 0.1);
    cam([0, 1.615, 0.03], 0.55, az, 2);
    step(1, 1 / 60);
  },
  step,
  synthFrame,
  /**
   * Синтетикалык мокапты колго алып ойнотуу: `ms` ичинде ар 33 мс сайын (реалдуу убакыт — фильтр
   * performance.now() колдонот) кадр берилип, сахна жылдырылат. Аягында кол абалын кайтарат.
   */
  async liveSim(mode: "waveL" | "fistR", ms: number): Promise<{ leftWristY: number; rightWristY: number; leftWristX: number }> {
    hideSheet();
    camReset();
    for (let t = 0; t <= ms; t += 33) {
      stage.setLiveFrame(synthFrame(t, mode));
      step(1, 0.033);
      await new Promise((r) => setTimeout(r, 33));
    }
    const sv = (stage as unknown as { solver: { worldPos: (n: string, o: THREE.Vector3) => THREE.Vector3 } }).solver;
    const L = sv.worldPos("LeftHand", new THREE.Vector3());
    const R = sv.worldPos("RightHand", new THREE.Vector3());
    return { leftWristY: +L.y.toFixed(3), rightWristY: +R.y.toFixed(3), leftWristX: +L.x.toFixed(3) };
  },
  /**
   * Кадр убактысы (бардык жесттер ойнотулуп жатканда): `tick()` чакырыгынын CPU+GPU-тапшыруу убактысы
   * (`frames` кадр, синхрондуу — rAF фондо токтоп калса да иштейт) + rAF боюнча чыныгы FPS аракети.
   */
  async perf(frames = 240): Promise<{ tickAvgMs: number; tickP95Ms: number; rafFps: number | null; calls: number; triangles: number }> {
    hideSheet();
    camReset();
    void play(DEMO_SIGNS.map((s) => ({ gloss: s.gloss, clip: s.clip })));
    step(10, 1 / 60);
    const gl = st.renderer.getContext();
    const deltas: number[] = [];
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      st.tick(1 / 60, t0);
      gl.finish();
      deltas.push(performance.now() - t0);
    }
    deltas.sort((x, y) => x - y);
    const tickAvgMs = deltas.reduce((x, y) => x + y, 0) / deltas.length;
    const tickP95Ms = deltas[Math.floor(deltas.length * 0.95)];
    const info = st.renderer.info.render;
    // rAF: 1.5 с ичинде канча кадр (фондо болсо null)
    let n = 0;
    const start = performance.now();
    await new Promise<void>((r) => {
      const f = () => {
        n++;
        if (performance.now() - start < 1500) requestAnimationFrame(f);
        else r();
      };
      requestAnimationFrame(f);
      setTimeout(r, 2500);
    });
    const rafFps = n > 10 ? n / ((performance.now() - start) / 1000) : null;
    stage.stop();
    return { tickAvgMs, tickP95Ms, rafFps, calls: info.calls, triangles: info.triangles };
  },
};
Object.assign(window, { dev: devApi });

// Эски контакт-барак API'си (шайкештик үчүн)
(window as unknown as { sheet: (list: [string, number][], cols?: number) => Promise<void> }).sheet = (list, cols = 5) => devApi.signSheet(list, 0, cols);

// GLB жолун текшерүү: процедуралык аватарды GLB'ге экспорттоп, кайра loadGLBAvatar менен жүктөйбүз
(window as unknown as { glbRoundTrip: () => Promise<string> }).glbRoundTrip = async () => {
  const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
  const { createProceduralAvatar } = await import("./rig");
  const rig = createProceduralAvatar();
  const buf = (await new GLTFExporter().parseAsync(rig.root, { binary: true })) as ArrayBuffer;
  rig.dispose();
  const url = URL.createObjectURL(new Blob([buf], { type: "model/gltf-binary" }));
  const el = document.createElement("div");
  el.style.cssText = "position:fixed;right:12px;bottom:12px;width:360px;height:420px;z-index:5;border:1px solid #556;border-radius:10px";
  document.body.appendChild(el);
  const st2 = new AvatarStage(el, { avatarUrl: url });
  await st2.ready;
  (window as unknown as { stage2: AvatarStage }).stage2 = st2;
  void st2.play([{ gloss: "ЖАКШЫ", clip: DEMO_SIGNS.find((d) => d.gloss === "ЖАКШЫ")!.clip }], { speed: 1e-6 });
  return `glb ${buf.byteLength} bytes`;
};
