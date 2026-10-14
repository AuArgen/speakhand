// vision-dev.html үчүн иштеп чыгуу барагы: камера (күзгүлөнгөн), оверлей, fps,
// кадрдын JSON'у, координаттар конвенциясын текшерүү жана сегментатордун иштеши.
//
// ?image=<url> — камеранын ордуна статикалык сүрөттү видео агым катары колдонот
// (камерасыз браузерде моделдерди текшерүү үчүн).
// window.__vision — автоматтык тесттер үчүн абал.

import type { MocapClip, MocapFrame } from "../lib/types";
import { drawOverlay } from "./overlay";
import { SignSegmenter } from "./segmenter";
import { Tracker, startCamera, stopCamera, type TrackResult } from "./tracker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("overlay");
const statusEl = $("status");
const fpsEl = $("fps");
const segEl = $("seg");
const checksEl = $("checks");
const dumpEl = $("dump");
const segsEl = $("segs");
const faceBox = $<HTMLInputElement>("face");
const fullBox = $<HTMLInputElement>("full");

interface DevState {
  status: string;
  error: string | null;
  tracker: Tracker | null;
  delegates: Tracker["delegates"] | null;
  frames: number;
  fps: number;
  detectMs: number;
  last: TrackResult | null;
  segments: number;
  createMs: number;
}
const state: DevState = { status: "init", error: null, tracker: null, delegates: null, frames: 0, fps: 0, detectMs: 0, last: null, segments: 0, createMs: 0 };
(window as unknown as { __vision: DevState }).__vision = state;

let stream: MediaStream | null = null;
let raf = 0;
const segmenter = new SignSegmenter();
const recent: string[] = [];

function setStatus(s: string, err?: unknown) {
  state.status = s;
  if (err) state.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  statusEl.textContent = err ? `${s}: ${state.error}` : s;
  statusEl.className = err ? "bad" : "";
}

async function createTracker(): Promise<Tracker> {
  state.tracker?.close();
  state.tracker = null;
  setStatus("моделдер жүктөлүүдө…");
  const t0 = performance.now();
  const t = await Tracker.create({ face: faceBox.checked, poseModel: fullBox.checked ? "full" : "lite" });
  state.createMs = Math.round(performance.now() - t0);
  state.tracker = t;
  state.delegates = t.delegates;
  setStatus(`моделдер даяр (${state.createMs} мс, ${JSON.stringify(t.delegates)})`);
  return t;
}

/** Статикалык сүрөттү видео агымга айландырат (камерасыз текшерүү үчүн). */
async function imageSource(url: string): Promise<MediaStream> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  let flip = false;
  const paint = () => {
    ctx.drawImage(img, 0, 0);
    // жаңы кадрлар чыгышы үчүн бир пикселди өзгөртөбүз
    ctx.fillStyle = (flip = !flip) ? "#000" : "#010101";
    ctx.fillRect(0, 0, 1, 1);
  };
  paint();
  setInterval(paint, 1000 / 30);
  const s = c.captureStream(30);
  video.srcObject = s;
  video.muted = true;
  await video.play();
  return s;
}

async function start() {
  stop();
  try {
    const image = new URLSearchParams(location.search).get("image");
    if (!image) setStatus("камерага уруксат күтүлүүдө…");
    const [t, s] = await Promise.all([
      state.tracker ? Promise.resolve(state.tracker) : createTracker(),
      image ? imageSource(image) : startCamera(video, { width: 640, height: 480 }),
    ]);
    stream = s;
    setStatus(`иштеп жатат · ${image ? "сүрөт" : "камера"} ${video.videoWidth}×${video.videoHeight} · ${JSON.stringify(t.delegates)}`);
    loop();
  } catch (e) {
    setStatus("ката", e);
  }
}

function stop() {
  cancelAnimationFrame(raf);
  stopCamera(stream);
  stream = null;
}

let fpsFrames = 0, fpsT = performance.now(), lastRender = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  const t = state.tracker;
  if (!t) return;
  const now = performance.now();
  const t0 = performance.now();
  const res = t.detect(video, now);
  if (!res) return;
  state.detectMs = Math.round((performance.now() - t0) * 10) / 10;
  state.last = res;
  state.frames++;
  fpsFrames++;
  if (now - fpsT >= 1000) {
    state.fps = Math.round((fpsFrames * 1000) / (now - fpsT));
    fpsFrames = 0; fpsT = now;
    fpsEl.textContent = `${state.fps} fps · detect ${state.detectMs} ms`;
  }
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  drawOverlay(canvas.getContext("2d")!, res, { mirrored: true, width: canvas.width, height: canvas.height });

  const seg = segmenter.push(res.frame);
  segEl.textContent = `${segmenter.active ? "SIGN" : "rest"} · e=${segmenter.activity.energy.toFixed(2)}`;
  segEl.classList.toggle("on", segmenter.active);
  if (seg) onSegment(seg);

  if (now - lastRender > 150) {
    lastRender = now;
    renderText(res);
  }
}

function onSegment(c: MocapClip) {
  state.segments++;
  const dur = Math.round(c.frames[c.frames.length - 1].t);
  const hands = c.frames.reduce((a, f) => a + (f.leftHand ? 1 : 0) * 1 + (f.rightHand ? 1 : 0) * 2, 0);
  recent.unshift(`#${state.segments}  ${dur} мс · ${c.frames.length} кадр · ${c.fps} fps · колдор=${hands}`);
  recent.length = Math.min(recent.length, 8);
  segsEl.textContent = recent.join("\n");
}

const fmt = (v: number[] | undefined) => (v ? `[${v.map((x) => x.toFixed(3)).join(", ")}]` : "—");

function renderText(res: TrackResult) {
  const f: MocapFrame = res.frame;
  dumpEl.textContent = JSON.stringify(
    {
      t: Math.round(f.t),
      pose: f.pose ? `${f.pose.length} pts` : null,
      leftHand: f.leftHand ? { present: true, by: res.handMethod?.left, wrist: f.leftHand[0] } : null,
      rightHand: f.rightHand ? { present: true, by: res.handMethod?.right, wrist: f.rightHand[0] } : null,
      face: f.face,
      delegates: state.delegates,
    },
    null,
    1,
  );

  const p = f.pose;
  if (!p) { checksEl.textContent = "pose жок — камерага толук көрүнүңүз"; checksEl.className = "mute"; return; }
  const lines: [boolean, string][] = [];
  const ls = p[11], rs = p[12], nose = p[0];
  const hipY = (p[23][1] + p[24][1]) / 2;
  const shMid = [(ls[0] + rs[0]) / 2, (ls[1] + rs[1]) / 2, (ls[2] + rs[2]) / 2];
  lines.push([ls[0] > rs[0], `+x = адамдын СОЛ тарабы: L ийин x=${ls[0].toFixed(3)} > R ийин x=${rs[0].toFixed(3)}`]);
  lines.push([nose[1] > hipY, `+y = өйдө: мурун y=${nose[1].toFixed(3)} > жамбаш y=${hipY.toFixed(3)}`]);
  lines.push([nose[2] > shMid[2], `+z = камерага карай: мурун z=${nose[2].toFixed(3)} > ийин z=${shMid[2].toFixed(3)}`]);
  const pi = res.image.pose;
  if (pi) lines.push([pi[11].x > pi[12].x, `сүрөттө (күзгүсүз) сол ийин оң жакта: ${pi[11].x.toFixed(2)} > ${pi[12].x.toFixed(2)}`]);
  const near = (h: { x: number; y: number }[] | null, idx: number) =>
    h && pi ? Math.hypot(h[0].x - pi[idx].x, h[0].y - pi[idx].y) : null;
  const dl = near(res.image.left, 15), dr = near(res.image.right, 16);
  if (dl !== null) lines.push([dl < 0.12, `leftHand ↔ pose сол билек (15): ${dl.toFixed(3)} (${res.handMethod?.left})`]);
  if (dr !== null) lines.push([dr < 0.12, `rightHand ↔ pose оң билек (16): ${dr.toFixed(3)} (${res.handMethod?.right})`]);
  lines.push([true, `L билек ${fmt(p[15])}  R билек ${fmt(p[16])}`]);
  checksEl.className = "";
  checksEl.innerHTML = lines.map(([ok, s]) => `<span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> ${s}`).join("\n");
}

$("cam").addEventListener("click", () => void start());
faceBox.addEventListener("change", () => void state.tracker?.setFace(faceBox.checked).catch((e) => setStatus("бет модели", e)));
fullBox.addEventListener("change", async () => {
  try { await createTracker(); } catch (e) { setStatus("ката", e); }
});

// Авто-старт: моделдерди жүктөп, анан камераны/сүрөттү ачабыз
(async () => {
  try {
    await createTracker();
  } catch (e) {
    setStatus("моделдер жүктөлгөн жок", e);
    return;
  }
  await start();
})();
