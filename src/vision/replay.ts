// vision-replay.html — сабак видеосун вебкамера сыяктуу ЧЫНЫГЫ түз эфир конвейери аркылуу өткөрүү:
// <video> → (бурмалоо: күзгү, чоңойтуу, жылдыруу, төмөн чечилиш, 15 fps, жарыктык) → канвас →
// Tracker.detect → LiveRecognizer (сегментатор → классификатор / сүйлөм декодери) → манифесттеги
// чындык (t0/t1, глосс) менен салыштыруу. Чыгарылышы: fps, кечигүү, top-1/top-5, сүйлөм дал келүүсү.
//
// URL параметрлери (башкаруу элементтерин алмаштырат): ?lesson=3&from=0&to=60&mode=sign|utterance
//   &vocab=conv|all&perturb=flip,zoom1.3,shift0.1,res360,fps15,bright1.3&rate=1&autorun=1
//   &videos=/@fs/C:/allpp/speak/tools/rsl_import/cache/videos  (Vite dev: долбоордун ичиндеги файлдар)
// window.__replay — автоматтык тесттер үчүн абал/жыйынтык.

import { CONVERSATION_VOCAB } from "../data/conversationVocab";
import { loadTemplateBank } from "../data/library";
import { fetchPhrases } from "../lib/room";
import type { MocapClip, Recognition } from "../lib/types";
import { SignClassifier } from "./classifier";
import type { UtteranceResult } from "./decoder";
import { LiveRecognizer, type LiveSegmentInfo } from "./live";
import { drawOverlay } from "./overlay";
import { Tracker, type TrackResult } from "./tracker";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const frameCanvas = $<HTMLCanvasElement>("frame");
const overlay = $<HTMLCanvasElement>("overlay");
const params = new URLSearchParams(location.search);
const ctl = {
  lesson: $<HTMLInputElement>("lesson"), from: $<HTMLInputElement>("from"), to: $<HTMLInputElement>("to"),
  mode: $<HTMLSelectElement>("mode"), vocab: $<HTMLSelectElement>("vocab"), perturb: $<HTMLInputElement>("perturb"), rate: $<HTMLInputElement>("rate"),
};
for (const [k, el] of Object.entries(ctl)) if (params.has(k)) (el as HTMLInputElement).value = params.get(k)!;
const VIDEOS = params.get("videos") ?? "/@fs/C:/allpp/speak/tools/rsl_import/cache/videos";

interface Item { id: string; gloss: string; lesson: number; t0: number; t1: number; clip?: string }
interface SignRow { truth: string; t0: number; t1: number; pred: string | null; top5: string[]; conf: number; ratio: number; delayMs: number; classifyMs: number }
interface UttRow { truth: string[]; pred: string[]; phrase: string | null; conf: number; startS: number; endS: number; decodeMs: number; delayMs: number; exact: boolean; errors: number }
interface ReplayState {
  status: string; done: boolean; fps: number; frames: number; detectMs: number; timing: { pose: number; hand: number; face: number } | null;
  signs: SignRow[]; utterances: UttRow[]; summary: Record<string, number | string> | null; error: string | null;
}
const state: ReplayState = { status: "init", done: false, fps: 0, frames: 0, detectMs: 0, timing: null, signs: [], utterances: [], summary: null, error: null };
(window as unknown as { __replay: ReplayState }).__replay = state;
const setStatus = (s: string, err?: unknown) => {
  state.status = s;
  if (err) state.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  $("status").textContent = err ? `${s}: ${state.error}` : s;
};

let tracker: Tracker | null = null;
let classifier: SignClassifier | null = null;
let phrases: { text: string; gloss: string[] }[] = [];
let manifest: Item[] = [];
let running = false;

async function prepare(): Promise<void> {
  setStatus("моделдер жүктөлүүдө…");
  const [t, bank, man, ph] = await Promise.all([
    Tracker.create({ face: false }),
    loadTemplateBank(),
    fetch("/signs/rsl/manifest.json").then((r) => r.json() as Promise<{ items: Item[] }>),
    fetchPhrases().catch(() => []),
  ]);
  tracker = t;
  manifest = man.items.filter((i) => i.clip);
  phrases = ph.map((p) => ({ text: p.text, gloss: p.gloss }));
  classifier = new SignClassifier();
  if (bank) classifier.addTemplates(bank);
  setStatus(`даяр · ${classifier.allGlosses.length} глосс · ${JSON.stringify(t.delegates)}`);
}

interface Perturb { flip: boolean; zoom: number; shift: number; width: number; fpsDiv: number; bright: number }
function parsePerturb(s: string): Perturb {
  const p: Perturb = { flip: false, zoom: 1, shift: 0, width: 0, fpsDiv: 1, bright: 1 };
  for (const tok of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z]+)([\d.]*)$/.exec(tok);
    if (!m) continue;
    const v = Number(m[2]);
    if (m[1] === "flip") p.flip = true;
    else if (m[1] === "zoom") p.zoom = v;
    else if (m[1] === "shift") p.shift = v;
    else if (m[1] === "res") p.width = Math.round((v * 16) / 9);
    else if (m[1] === "fps") p.fpsDiv = Math.max(1, Math.round(30 / v));
    else if (m[1] === "bright") p.bright = v;
  }
  return p;
}

function editDistance(a: string[], b: string[]): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  state.done = false; state.signs = []; state.utterances = []; state.summary = null; state.frames = 0;
  try {
    if (!tracker) await prepare();
    const lesson = Number(ctl.lesson.value), from = Number(ctl.from.value), to = Number(ctl.to.value);
    const mode = ctl.mode.value as "sign" | "utterance";
    const pert = parsePerturb(ctl.perturb.value);
    classifier!.setVocabulary(ctl.vocab.value === "conv" ? CONVERSATION_VOCAB : null);
    // эксперимент: ?smooth=0.5 (кадрларды жылмалоо), ?reject=3 (четке кагуу катышы; демейки — классификатордуку)
    if (params.has("smooth")) classifier!.configure({ smooth: Number(params.get("smooth")) });
    if (params.has("reject")) classifier!.configure({ rejectRatio: Number(params.get("reject")) });
    const items = manifest.filter((i) => i.lesson === lesson && i.t1 > from && i.t0 < to).sort((a, b) => a.t0 - b.t0);
    const inVocab = new Set(classifier!.vocabulary);

    video.src = `${VIDEOS}/l${String(lesson).padStart(2, "0")}.mp4`;
    await new Promise<void>((res, rej) => { video.onloadedmetadata = () => res(); video.onerror = () => rej(new Error(`видео жүктөлгөн жок: ${video.src}`)); });
    video.currentTime = from;
    await new Promise<void>((res) => { video.onseeked = () => res(); });
    video.playbackRate = Number(ctl.rate.value) || 1;

    const W = pert.width || video.videoWidth, H = Math.round((W * video.videoHeight) / video.videoWidth);
    frameCanvas.width = W; frameCanvas.height = H;
    overlay.width = W; overlay.height = H;
    const fctx = frameCanvas.getContext("2d", { alpha: false })!;
    const octx = overlay.getContext("2d")!;

    // пайда болгон жесттер/сүйлөмдөр
    const segs: { startT: number; endT: number; emitT: number; wall: number; r: Recognition | null; classifyMs: number; ratio: number }[] = [];
    const utts: { startT: number; endT: number; emitT: number; r: UtteranceResult | null; classifyMs: number }[] = [];
    const live = new LiveRecognizer(classifier, {
      onSegment: (c: MocapClip, r, info: LiveSegmentInfo) => segs.push({ ...info, wall: performance.now(), r, ratio: classifier!.classifyDetailed(c)?.ratio ?? NaN }),
      onUtterance: (_c: MocapClip, r, info: LiveSegmentInfo) => utts.push({ ...info, r }),
    }, { mode, phrases });

    let frames = 0, fpsFrames = 0, fpsT = performance.now(), videoFrame = 0;
    let lastVT = -1;
    // step=1: детерминдик режим — видео ойнотулбайт, ар бир кадрга (1/30 с) seek кылынат, баары иштетилет
    // (трекердин ылдамдыгына көз каранды эмес; бурмалоолорду салыштыруу үчүн). Демейки — реалдуу убакыт.
    const stepMode = params.get("step") === "1";
    setStatus(`иштеп жатат · l${lesson} ${from}–${to} с · ${mode} · ${ctl.vocab.value} · [${ctl.perturb.value}]${stepMode ? " · step" : ""}`);
    const processFrame = (vt: number) => {
        // бурмалоо менен канваска тартуу
        fctx.save();
        fctx.filter = pert.bright !== 1 ? `brightness(${pert.bright})` : "none";
        fctx.translate(W / 2 + pert.shift * W, H / 2);
        fctx.scale((pert.flip ? -1 : 1) * pert.zoom, pert.zoom);
        fctx.drawImage(video, -W / 2, -H / 2, W, H);
        fctx.restore();
        const t0 = performance.now();
        const res: TrackResult | null = tracker!.detect(frameCanvas, vt * 1000);
        state.detectMs = performance.now() - t0;
        if (!res) return;
        state.timing = tracker!.lastTiming;
        frames++; fpsFrames++;
        const now = performance.now();
        if (now - fpsT >= 1000) { state.fps = Math.round((fpsFrames * 1000) / (now - fpsT)); fpsFrames = 0; fpsT = now; $("fps").textContent = `${state.fps} fps · detect ${state.detectMs.toFixed(0)} ms (pose ${res.timing?.pose.toFixed(0)} / hand ${res.timing?.hand.toFixed(0)})`; }
        octx.clearRect(0, 0, W, H);
        drawOverlay(octx, res, { mirrored: false, width: W, height: H });
        const pose = res.image.pose;
        live.push(res.frame, pose ? { vis: pose.map((p) => p.v ?? 1) } : undefined);
        const seg = live.segmenter.active;
        $("seg").textContent = seg ? (mode === "utterance" ? "СҮЙЛӨМ" : "ЖЕСТ") : "rest";
        $("seg").classList.toggle("on", seg);
    };
    if (stepMode) {
      const dt = pert.fpsDiv / 30;
      for (let t = from; t < to; t += dt) {
        video.currentTime = t;
        await new Promise<void>((res) => { video.onseeked = () => res(); });
        processFrame(t);
      }
    } else {
      await video.play();
      const rvfc = "requestVideoFrameCallback" in video;
      await new Promise<void>((resolve) => {
        const step = () => {
          if (video.ended || video.currentTime >= to) { video.pause(); resolve(); return; }
          if (rvfc) (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(step);
          else requestAnimationFrame(step);
          const vt = video.currentTime;
          if (vt === lastVT) return;
          lastVT = vt;
          videoFrame++;
          if (videoFrame % pert.fpsDiv !== 0) return;
          processFrame(vt);
        };
        step();
      });
    }
    live.flush(to * 1000);
    state.frames = frames;

    // ───── салыштыруу ─────
    const log: string[] = [];
    if (mode === "sign") {
      const used = new Set<number>();
      for (const it of items) {
        if (!inVocab.has(it.gloss)) continue;
        const a = it.t0 * 1000, b = it.t1 * 1000;
        let best = -1, bestOv = 0;
        segs.forEach((s, i) => { const ov = Math.min(b, s.endT) - Math.max(a, s.startT); if (ov > bestOv) { bestOv = ov; best = i; } });
        const s = best >= 0 && bestOv > 0.3 * (b - a) ? segs[best] : null;
        if (s) used.add(best);
        const row: SignRow = { truth: it.gloss, t0: it.t0, t1: it.t1, pred: s?.r?.gloss ?? null, top5: s?.r ? [s.r.gloss, ...s.r.alternatives.map((x) => x.gloss)] : [], conf: s?.r?.confidence ?? 0, ratio: s?.ratio ?? NaN, delayMs: s ? s.emitT - s.endT : NaN, classifyMs: s?.classifyMs ?? NaN };
        state.signs.push(row);
        log.push(`${row.pred === row.truth ? "✓" : row.top5.includes(row.truth) ? "~" : s ? "✗" : "·"} ${it.t0.toFixed(1)}s ${it.gloss} → ${row.pred ?? "—"} ${(row.conf * 100).toFixed(0)}% ratio ${row.ratio.toFixed(2)}`);
      }
      const n = state.signs.length, det = state.signs.filter((r) => r.pred !== null);
      const top1 = state.signs.filter((r) => r.pred === r.truth).length, top5 = state.signs.filter((r) => r.top5.includes(r.truth)).length;
      const acc = state.signs.filter((r) => r.pred === r.truth && r.conf >= 0.45).length;
      const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
      state.summary = { items: n, detected: det.length, top1, top5, acceptedCorrect: acc, spurious: segs.length - used.size, delayMedMs: med(det.map((r) => r.delayMs)), classifyMedMs: med(det.map((r) => r.classifyMs)), fps: state.fps, frames };
      $("summary").textContent = `жесттер ${n} · табылды ${det.length} · top1 ${top1} (${n ? Math.round((100 * top1) / n) : 0}%) · top5 ${top5} · кабыл алынды&туура ${acc} · ашыкча ${segs.length - used.size}\nкечигүү (сегмент) ${state.summary.delayMedMs} мс · классификация ${Number(state.summary.classifyMedMs).toFixed(0)} мс · ${state.fps} fps`;
    } else {
      for (const u of utts) {
        const truth = items.filter((it) => Math.min(it.t1 * 1000, u.endT) - Math.max(it.t0 * 1000, u.startT) > 0.3 * (it.t1 - it.t0) * 1000).map((it) => it.gloss);
        const pred = u.r?.gloss ?? [];
        const row: UttRow = { truth, pred, phrase: u.r?.phrase?.text ?? null, conf: u.r?.confidence ?? 0, startS: u.startT / 1000, endS: u.endT / 1000, decodeMs: u.classifyMs, delayMs: u.emitT - u.endT, exact: truth.length === pred.length && truth.every((g, i) => g === pred[i]), errors: editDistance(truth, pred) };
        state.utterances.push(row);
        log.push(`${row.exact ? "✓" : "✗"} ${row.startS.toFixed(1)}–${row.endS.toFixed(1)}s [${truth.join(" | ")}] → [${pred.join(" | ")}]${row.phrase ? ` «${row.phrase}»` : ""} ${(row.conf * 100).toFixed(0)}% · ${row.decodeMs.toFixed(0)} мс`);
      }
      const n = state.utterances.length, words = state.utterances.reduce((a, r) => a + r.truth.length, 0), errs = state.utterances.reduce((a, r) => a + r.errors, 0);
      const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
      state.summary = { utterances: n, exact: state.utterances.filter((r) => r.exact).length, wer: words ? errs / words : NaN, decodeMedMs: med(state.utterances.map((r) => r.decodeMs)), delayMedMs: med(state.utterances.map((r) => r.delayMs)), fps: state.fps, frames };
      $("summary").textContent = `сүйлөмдөр ${n} · так ${state.summary.exact} · WER ${(100 * Number(state.summary.wer)).toFixed(0)}% · декод ${Number(state.summary.decodeMedMs).toFixed(0)} мс · кечигүү ${state.summary.delayMedMs} мс · ${state.fps} fps`;
    }
    $("log").textContent = log.join("\n") || "—";
    $("log").className = "";
    setStatus(`бүттү · ${frames} кадр · ${state.fps} fps`);
  } catch (e) {
    setStatus("ката", e);
  } finally {
    running = false;
    state.done = true;
  }
}

$("run").addEventListener("click", () => void run());
void prepare().then(() => { if (params.get("autorun") === "1") void run(); }).catch((e) => setStatus("моделдер жүктөлгөн жок", e));
