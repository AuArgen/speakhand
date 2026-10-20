// Utterance replay: multi-sign utterances through the REAL live pipeline in "utterance" mode
// (LiveRecognizer: SignSegmenter[hands-down end] → UtteranceDecoder → gloss sequence).
//
// Test material (from cache/stream/lNN.json, see dumpstream.py):
//   • synthetic utterances: 2–5 CONSECUTIVE single-sign intervals of a lesson (each trimmed to the part
//     where a hand is above the rest zone — the manifest t0/t1 include the signer lowering the hands),
//     joined with a short interpolated transition (the hand moves straight to the next sign's start,
//     250 ms) so that the hands are lowered only at the end; 2 s of natural rest frames before and after.
//     Ground truth = the gloss sequence of the joined items.
//   • lesson 27 ("common phrases"): each item is a multi-sign phrase stored as ONE library template;
//     utterances of 1–3 consecutive phrase items are built the same way.
// Metrics: exact-match rate, WER (edit distance / reference words), per-utterance decode latency at
// hands-down (decoder.finish), incremental cost while signing, segmenter end delay.
//
//   npx tsx tools/rsl_import/utterreplay.ts [--lessons=3,5,12,22] [--n=40] [--k=2-5] [--vocab=all|conv]
//       [--perturb=...] [--llo] [--nophrasebook] [--ins=0.2] [--skip=1.1] [--still=1500] [--v] [--json=out.json]
import { writeFileSync } from "node:fs";
import { SignClassifier } from "../../src/vision/classifier";
import { CONVERSATION_VOCAB } from "../../src/data/conversationVocab";
import type { DecoderOptions, PhraseTemplate, UtteranceResult } from "../../src/vision/decoder";
import { LiveRecognizer } from "../../src/vision/live";
import { MotionMeter, RestTracker, wristLevel as wristLevelDbg } from "../../src/vision/segmenter";
import { applyPerturbations, bankWithout, editDistance, fullBank, lerpFrame, loadStream, manifest, mean, med, parseArgs, pct, phrasebook, q, rnd, resetSeed, type Item, type StreamFrame } from "./replaylib";

const args = parseArgs(process.argv.slice(2));
const lessons = (args.get("lessons") ?? "3,5,12,22,27").split(",").map(Number);
const perUtt = Number(args.get("n") ?? 40);
const [kMin, kMax] = (args.get("k") ?? "2-5").split("-").map(Number);
const vocabMode = args.get("vocab") ?? "all";
const llo = args.has("llo");
const perturb = (args.get("perturb") ?? "").split(",").filter(Boolean);
const usePhrasebook = !args.has("nophrasebook");
const verbose = args.has("v");
const decOpts: DecoderOptions = {};
if (args.has("ins")) decOpts.insertion = Number(args.get("ins"));
if (args.has("skip")) decOpts.skipCost = Number(args.get("skip"));
if (args.has("lmb")) decOpts.lmBigram = Number(args.get("lmb"));
if (args.has("prom")) decOpts.prominence = Number(args.get("prom"));
if (args.has("gap")) decOpts.minGapMs = Number(args.get("gap"));
if (args.has("span")) decOpts.maxSpan = Number(args.get("span"));
if (args.has("repeat")) decOpts.repeatPenalty = Number(args.get("repeat"));
if (args.has("maxgap")) decOpts.maxGapMs = Number(args.get("maxgap"));
if (args.has("topk")) decOpts.topK = Number(args.get("topk"));
/** --still=1500: сүйлөм ушунча мс кыймылсыздыктан кийин бүтөт (демейки UTTERANCE_SEGMENTER) */
const segOpts = args.has("still") ? { stillMs: Number(args.get("still")) } : undefined;

const TRANSITION_MS = 250;
const PRE_MS = 150, POST_MS = 100, REST_MS = 2000;

interface Utt { lesson: number; truth: string[]; frames: StreamFrame[]; durMs: number }

/** Join consecutive items of one lesson into an utterance (hands up throughout, rest only at the ends). */
function buildUtterance(stream: StreamFrame[], fps: number, items: Item[], raised: boolean[], prevEnd: number, nextStart: number): Utt | null {
  const dt = 1000 / fps;
  const at = (ms: number) => Math.max(0, Math.min(stream.length - 1, Math.round(ms / dt)));
  const out: StreamFrame[] = [];
  let t = 0;
  const push = (f: StreamFrame) => { out.push({ ...f, t }); t += dt; };
  // natural rest before the first sign: only frames inside the gap after the previous sign (not its tail);
  // a short gap is padded by holding the first rest frame
  const preA = Math.max(prevEnd * 1000 + 300, items[0].t0 * 1000 - PRE_MS - REST_MS), preB = items[0].t0 * 1000 - PRE_MS;
  for (let ms = preB - REST_MS; ms < preB; ms += dt) push(stream[at(Math.max(preA, ms))]);
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    let a = at(it.t0 * 1000 - PRE_MS), b = at(it.t1 * 1000 + POST_MS);
    // trim to the raised part (hands above the rest zone)
    while (a < b && !raised[a]) a++;
    while (b > a && !raised[b]) b--;
    if (b - a < 5) { a = at(it.t0 * 1000); b = at(it.t1 * 1000); }
    if (k > 0) {
      // transition: straight interpolation from the previous sign's last frame to this sign's first
      const prev = out[out.length - 1], next = stream[a];
      const n = Math.round(TRANSITION_MS / dt);
      for (let j = 1; j < n; j++) push(lerpFrame(prev, next, j / n, 0));
    }
    for (let i = a; i <= b; i++) push(stream[i]);
  }
  const last = items[items.length - 1];
  const postA = last.t1 * 1000 + POST_MS + dt, postB = Math.min(nextStart * 1000 - 300, postA + REST_MS);
  for (let ms = postA; ms < postA + REST_MS; ms += dt) push(stream[at(Math.min(postB, ms))]);
  if (out.length < 10) return null;
  return { lesson: items[0].lesson, truth: items.map((i) => i.gloss), frames: out, durMs: t };
}

function makeUtterances(lesson: number): { utts: Utt[]; fps: number } {
  const st = loadStream(lesson);
  const meter = new MotionMeter();
  const rest = new RestTracker();
  const raised = st.frames.map((f) => { const m = meter.push(f); return rest.push(f, m.energy, m.scale, f.vis); });
  const items = manifest.items.filter((i) => i.lesson === lesson && i.clip).sort((a, b) => a.t0 - b.t0);
  const utts: Utt[] = [];
  resetSeed(1000 + lesson);
  let guard = 0;
  while (utts.length < perUtt && guard++ < perUtt * 20) {
    const k = kMin + Math.floor(rnd() * (kMax - kMin + 1));
    const s = Math.floor(rnd() * Math.max(1, items.length - k));
    const group = items.slice(s, s + k);
    if (group.length < Math.min(k, 2)) continue;
    // consecutive items must be close (same scene) and not overlap
    let ok = true;
    for (let i = 1; i < group.length; i++) if (group[i].t0 - group[i - 1].t1 > 4 || group[i].t0 < group[i - 1].t1) ok = false;
    if (!ok) continue;
    const u = buildUtterance(st.frames, st.fps, group, raised, items[s - 1]?.t1 ?? 0, items[s + k]?.t0 ?? Infinity);
    if (u) utts.push(u);
  }
  return { utts, fps: st.fps };
}

interface Res { truth: string[]; pred: string[]; exact: boolean; errors: number; decodeMs: number; pushMsMax: number; pushMsMean: number; endDelay: number; phrase: string | null; conf: number; segmentsOut: number; bounds: number; evaluated: number; truncated: boolean }

function run(lesson: number): Res[] {
  const { utts, fps } = makeUtterances(lesson);
  const clf = new SignClassifier();
  clf.addTemplates(llo ? bankWithout(lesson) : fullBank);
  if (vocabMode === "conv") clf.setVocabulary(CONVERSATION_VOCAB);
  const phrases: PhraseTemplate[] = usePhrasebook ? phrasebook.items.map((p) => ({ text: p.text, gloss: p.gloss })) : [];
  const res: Res[] = [];
  for (const u of utts) {
    const { frames } = applyPerturbations(u.frames, fps, perturb);
    let result: UtteranceResult | null = null, emitT = NaN, endT = NaN, classifyMs = 0, count = 0;
    const live = new LiveRecognizer(clf, {
      onUtterance: (_clip, r, info) => { if (!count++) { result = r; emitT = info.emitT; endT = info.endT; classifyMs = info.classifyMs; } },
    }, { mode: "utterance", phrases, decoder: decOpts, provisionalMs: 300, segmenter: segOpts });
    const pushMs: number[] = [];
    let finishIdx = -1;
    if (args.has("debugrest") && res.length === 0) {
      const meter = new MotionMeter(), rt = new RestTracker();
      const rows = frames.map((f) => { const m = meter.push(f); const r = rt.push(f, m.energy, m.scale, f.vis); return `${(f.t / 1000).toFixed(2)}:${(wristLevelDbg(f, m.scale, f.vis)).toFixed(2)}/${m.energy.toFixed(1)}${r ? "R" : "-"}`; });
      console.log("   rest debug (t:level/energy raised?):", rows.filter((_, i) => i % 3 === 0).join(" "));
    }
    for (const f of frames) {
      const t0 = performance.now();
      const before = count;
      live.push(f, { vis: f.vis });
      pushMs.push(performance.now() - t0);
      if (count > before && finishIdx < 0) finishIdx = pushMs.length - 1;
    }
    // бүтүрүү кадры (декод) өзүнчө өлчөнөт — "push max" инкременталдык иштин гана чеги
    if (finishIdx >= 0) pushMs.splice(finishIdx, 1);
    if (!count) live.flush(frames[frames.length - 1].t);
    const r = result as UtteranceResult | null;
    const pred = r?.gloss ?? [];
    const inVocab = u.truth.every((g) => clf.vocabulary.includes(g));
    if (!inVocab) continue;
    res.push({
      truth: u.truth, pred, exact: pred.length === u.truth.length && pred.every((g, i) => g === u.truth[i]),
      errors: editDistance(u.truth, pred), decodeMs: classifyMs, pushMsMax: Math.max(...pushMs), pushMsMean: mean(pushMs),
      endDelay: emitT - endT, phrase: r?.phrase?.text ?? null, conf: r?.confidence ?? 0, segmentsOut: r?.segments.length ?? 0,
      bounds: r?.stats?.bounds ?? 0, evaluated: r?.stats?.evaluated ?? 0, truncated: count > 1,
    });
    if (verbose) console.log(`   ${res[res.length - 1].exact ? "✓" : "✗"} [${u.truth.join(" | ")}] → [${pred.join(" | ")}] ${r?.phrase ? `«${r.phrase.text}» ` : ""}conf ${(100 * (r?.confidence ?? 0)).toFixed(0)}% · ${classifyMs.toFixed(0)} ms (phrases ${r?.stats?.phraseMs.toFixed(0)}) · bounds ${r?.stats?.bounds} · eval ${r?.stats?.evaluated} (${r?.stats?.evaluatedAtFinish} at finish) · push max ${Math.max(...pushMs).toFixed(0)} ms${count > 1 ? " · SPLIT" : ""}`);
  }
  return res;
}

const all: Res[] = [];
console.log(`utterances: lessons ${lessons.join(",")} · ${perUtt}/lesson · k=${kMin}-${kMax} · vocab=${vocabMode}${llo ? " LLO" : ""} · perturb=[${perturb.join(",")}] · phrasebook=${usePhrasebook} · dec=${JSON.stringify(decOpts)}`);
for (const les of lessons) {
  const r = run(les);
  all.push(...r);
  const words = r.reduce((a, x) => a + x.truth.length, 0);
  const errs = r.reduce((a, x) => a + x.errors, 0);
  console.log(`l${les.toString().padStart(2, "0")}: ${r.length} utt · exact ${pct(r.filter((x) => x.exact).length, r.length)} · WER ${pct(errs, words)} · decode ${med(r.map((x) => x.decodeMs)).toFixed(0)} ms med / ${q(r.map((x) => x.decodeMs), 0.9).toFixed(0)} p90 · push max ${q(r.map((x) => x.pushMsMax), 0.9).toFixed(0)} ms p90 · end delay ${med(r.map((x) => x.endDelay)).toFixed(0)} ms · split ${r.filter((x) => x.truncated).length} · phrase ${r.filter((x) => x.phrase).length}`);
}
const words = all.reduce((a, x) => a + x.truth.length, 0);
const errs = all.reduce((a, x) => a + x.errors, 0);
const summary = {
  utterances: all.length, exact: all.filter((x) => x.exact).length, wer: errs / words,
  decodeMsMed: med(all.map((x) => x.decodeMs)), decodeMsP90: q(all.map((x) => x.decodeMs), 0.9), decodeMsMax: Math.max(...all.map((x) => x.decodeMs)),
  pushMsMaxP90: q(all.map((x) => x.pushMsMax), 0.9), pushMsMean: mean(all.map((x) => x.pushMsMean)),
  endDelayMs: med(all.map((x) => x.endDelay)), split: all.filter((x) => x.truncated).length, phrase: all.filter((x) => x.phrase).length,
  bounds: mean(all.map((x) => x.bounds)), evaluated: mean(all.map((x) => x.evaluated)),
};
console.log(
  `TOTAL: ${summary.utterances} utt · exact ${pct(summary.exact, summary.utterances)} · WER ${(100 * summary.wer).toFixed(1)}% · decode ${summary.decodeMsMed.toFixed(0)} ms med / ${summary.decodeMsP90.toFixed(0)} p90 / ${summary.decodeMsMax.toFixed(0)} max` +
  ` · push ${summary.pushMsMean.toFixed(1)} ms mean, max p90 ${summary.pushMsMaxP90.toFixed(0)} ms · end delay ${summary.endDelayMs.toFixed(0)} ms · split ${summary.split} · phrase hits ${summary.phrase} · bounds ${summary.bounds.toFixed(1)} · segs evaluated ${summary.evaluated.toFixed(1)}`,
);
if (args.has("json")) writeFileSync(args.get("json")!, JSON.stringify({ args: Object.fromEntries(args), summary, items: all }, null, 1));
