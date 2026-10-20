// Live-pipeline replay (SINGLE-SIGN mode) over the cached lesson tracking (cache/stream/lNN.json from
// dumpstream.py): frames are pushed one by one through the REAL live pipeline (LiveRecognizer in
// "sign" mode = SignSegmenter → SignClassifier with the precomputed bank), exactly like
// CameraView.onFrame does, and the emitted segments are matched against the manifest ground truth
// (t0/t1 per sign in the lesson video). For multi-sign utterances see utterreplay.ts.
//
//   npx tsx tools/rsl_import/livereplay.ts [--lessons=1,3,5] [--preset=legacy|live] [--vocab=all|conv]
//       [--llo] [--perturb=mirror,fps15,noise3,scale0.9,speed1.3,drop0.1,arm0.9,tilt10,yaw15]
//       [--smooth=0.5] [--still=250] [--rest=300] [--band=0.2] [--bias=1] [--threshold=0.55] [--json=out.json] [--v]
//
// --llo  leave-lesson-out: the replayed lesson's own templates are removed from the bank, so a sign can
//        only be recognised from a DIFFERENT performance of the same gloss (another lesson). Numbers are
//        reported over the items whose gloss exists elsewhere. NOTE: library "variants" of one gloss are
//        often different signs (homonyms of the Kyrgyz gloss), so this is a pessimistic bound.
// Perturbations: see replaylib.ts applyPerturbations().
import { writeFileSync } from "node:fs";
import { SignClassifier } from "../../src/vision/classifier";
import { CONVERSATION_VOCAB } from "../../src/data/conversationVocab";
import { LiveRecognizer, type LiveSegmentInfo } from "../../src/vision/live";
import type { SegmenterOptions } from "../../src/vision/segmenter";
import { applyPerturbations, bankWithout, fullBank, loadStream, manifest, med, mean, parseArgs, pct } from "./replaylib";

const args = parseArgs(process.argv.slice(2));
const lessons = (args.get("lessons") ?? "1,3,5,8,12,16,20,22,27").split(",").map(Number);
const preset = args.get("preset") ?? "live";
const vocabMode = args.get("vocab") ?? "all";
const llo = args.has("llo");
const perturb = (args.get("perturb") ?? "").split(",").filter(Boolean);
const smooth = Number(args.get("smooth") ?? 0);
const band = Number(args.get("band") ?? 0.2);
const bias = Number(args.get("bias") ?? 1);
const threshold = Number(args.get("threshold") ?? 0.55);
const handedness = (args.get("handedness") ?? "auto") as "auto" | "left" | "right";
const verbose = args.has("v");

const segOpts: SegmenterOptions =
  preset === "legacy"
    ? { minMs: 300, maxMs: 4000, restMs: 400, stillMs: 400 }
    : { stillMs: Number(args.get("still") ?? 250), restMs: Number(args.get("rest") ?? 300), minMs: Number(args.get("min") ?? 250) };

interface Seg { startT: number; endT: number; emitT: number; gloss: string | null; conf: number; top5: string[]; classifyMs: number; mirrored: boolean }
interface ItemResult { id: string; gloss: string; t0: number; t1: number; detected: boolean; top1: boolean; top5: boolean; accepted: boolean; pred: string | null; conf: number; segDelay: number; capDelay: number; splits: number; inVocab: boolean }

function replayLesson(lesson: number) {
  const st = loadStream(lesson);
  const { frames, timeScale } = applyPerturbations(st.frames, st.fps, perturb);
  const clf = new SignClassifier({ band, userBias: bias, smooth, handedness, rejectRatio: Number(args.get("reject") ?? 2) });
  clf.addTemplates(llo ? bankWithout(lesson) : fullBank);
  const bankGlosses = new Set(clf.allGlosses);
  if (vocabMode === "conv") clf.setVocabulary(CONVERSATION_VOCAB);
  const segs: Seg[] = [];
  const live = new LiveRecognizer(clf, {
    onSegment: (_clip, r, info: LiveSegmentInfo) => {
      segs.push({
        startT: info.startT, endT: info.endT, emitT: info.emitT, gloss: r?.gloss ?? null, conf: r?.confidence ?? 0,
        top5: r ? [r.gloss, ...r.alternatives.map((a) => a.gloss)] : [], classifyMs: info.classifyMs, mirrored: info.mirrored,
      });
    },
  }, { mode: "sign", segmenter: segOpts, provisionalMs: 0 });
  const t0 = performance.now();
  for (const f of frames) live.push(f, { vis: f.vis });
  live.flush();
  const pipelineMs = performance.now() - t0;

  const items = manifest.items.filter((i) => i.lesson === lesson && i.clip);
  const used = new Set<Seg>();
  const results: ItemResult[] = items.map((it) => {
    const a = it.t0 * 1000 * timeScale, b = it.t1 * 1000 * timeScale;
    let best: Seg | null = null, bestOv = 0, splits = 0;
    for (const s of segs) {
      const ov = Math.min(b, s.endT) - Math.max(a, s.startT);
      if (ov <= 0) continue;
      if (ov > 0.25 * Math.min(b - a, s.endT - s.startT)) splits++;
      if (ov > bestOv) { bestOv = ov; best = s; }
    }
    const detected = !!best && bestOv > 0.3 * (b - a);
    if (best && detected) used.add(best);
    const inVocab = bankGlosses.has(it.gloss) && (vocabMode !== "conv" || CONVERSATION_VOCAB.includes(it.gloss));
    return {
      id: it.id, gloss: it.gloss, t0: it.t0, t1: it.t1, detected,
      top1: detected && best!.gloss === it.gloss,
      top5: detected && best!.top5.includes(it.gloss),
      accepted: detected && best!.conf >= threshold,
      pred: detected ? best!.gloss : null, conf: detected ? best!.conf : 0,
      segDelay: detected ? best!.emitT - best!.endT : NaN,
      capDelay: detected ? best!.emitT - b : NaN,
      splits, inVocab,
    };
  });
  const spurious = segs.filter((s) => !used.has(s) && s.conf >= threshold).length;
  return { items: results, spurious, segs: segs.length, frames: frames.length, pipelineMs, classifyMs: segs.map((s) => s.classifyMs) };
}

const all: ItemResult[] = [];
let spurious = 0, segsTotal = 0, framesTotal = 0, pipelineTotal = 0;
const classifyMs: number[] = [];
console.log(`preset=${preset} vocab=${vocabMode}${llo ? " LLO" : ""} perturb=[${perturb.join(",")}] smooth=${smooth} band=${band} bias=${bias} seg=${JSON.stringify(segOpts)} thr=${threshold}`);
for (const les of lessons) {
  const r = replayLesson(les);
  all.push(...r.items);
  spurious += r.spurious; segsTotal += r.segs; framesTotal += r.frames; pipelineTotal += r.pipelineMs;
  classifyMs.push(...r.classifyMs);
  const it = r.items.filter((i) => i.inVocab);
  const det = it.filter((i) => i.detected);
  console.log(
    `l${les.toString().padStart(2, "0")}: items ${it.length}/${r.items.length} · detected ${pct(det.length, it.length)} · top1 ${pct(it.filter((i) => i.top1).length, it.length)} · top5 ${pct(it.filter((i) => i.top5).length, it.length)}` +
    ` · accepted&correct ${pct(it.filter((i) => i.accepted && i.top1).length, it.length)} · accepted&wrong ${it.filter((i) => i.accepted && !i.top1).length} · spurious ${r.spurious}/${r.segs} segs` +
    ` · delay seg ${med(det.map((i) => i.segDelay)).toFixed(0)} ms, cap ${med(det.map((i) => i.capDelay)).toFixed(0)} ms · splits ${it.filter((i) => i.splits > 1).length}`,
  );
  if (verbose) for (const i of it) console.log(`   ${i.top1 ? "✓" : i.top5 ? "~" : i.detected ? "✗" : "·"} ${i.gloss.padEnd(16)} → ${(i.pred ?? "—").padEnd(16)} ${(i.conf * 100).toFixed(0).padStart(3)}% delay ${Number.isFinite(i.segDelay) ? i.segDelay.toFixed(0) : "—"} ms`);
}
const it = all.filter((i) => i.inVocab);
const det = it.filter((i) => i.detected);
const summary = {
  items: it.length, detected: det.length,
  top1: it.filter((i) => i.top1).length, top5: it.filter((i) => i.top5).length,
  acceptedCorrect: it.filter((i) => i.accepted && i.top1).length, acceptedWrong: it.filter((i) => i.accepted && !i.top1).length,
  spurious, segs: segsTotal, splits: it.filter((i) => i.splits > 1).length,
  segDelayMs: med(det.map((i) => i.segDelay)), capDelayMs: med(det.map((i) => i.capDelay)),
  classifyMsMed: med(classifyMs), classifyMsMean: mean(classifyMs), pipelineUsPerFrame: (1000 * pipelineTotal) / framesTotal,
};
console.log(
  `TOTAL: items ${summary.items} · detected ${pct(summary.detected, summary.items)} · top1 ${pct(summary.top1, summary.items)} · top5 ${pct(summary.top5, summary.items)}` +
  ` · accepted&correct ${pct(summary.acceptedCorrect, summary.items)} · accepted&wrong ${summary.acceptedWrong} · spurious ${spurious}/${segsTotal} · splits ${summary.splits}` +
  `\n       delay: segmenter ${summary.segDelayMs.toFixed(0)} ms, vs caption end ${summary.capDelayMs.toFixed(0)} ms · classify ${summary.classifyMsMed.toFixed(1)} ms med / ${summary.classifyMsMean.toFixed(1)} mean · pipeline ${summary.pipelineUsPerFrame.toFixed(0)} µs/frame`,
);
if (args.has("json")) writeFileSync(args.get("json")!, JSON.stringify({ args: Object.fromEntries(args), summary, items: all }, null, 1));
