// Profile the decoder's per-segment cost: rankSequence (with/without include) and distancesFor.
//   npx tsx tools/rsl_import/profdecode.ts
import { SignClassifier } from "../../src/vision/classifier";
import { CONVERSATION_VOCAB } from "../../src/data/conversationVocab";
import { clipFeatures } from "../../src/vision/features";
import { toClip } from "../../src/vision/segmenter";
import { fullBank, loadStream, manifest, phrasebook } from "./replaylib";

const st = loadStream(12);
const items = manifest.items.filter((i) => i.lesson === 12 && i.clip).slice(0, 20);
const qs = items.map((it) => clipFeatures(toClip(st.frames.slice(Math.round(it.t0 * st.fps), Math.round(it.t1 * st.fps))))!);
const phraseGlosses = new Set(phrasebook.items.flatMap((p) => p.gloss));

for (const vocab of ["all", "conv"] as const) {
  const clf = new SignClassifier();
  clf.addTemplates(fullBank);
  if (vocab === "conv") clf.setVocabulary(CONVERSATION_VOCAB);
  const known = new Set(clf.allGlosses);
  const pg = [...phraseGlosses].filter((g) => known.has(g));
  const time = (label: string, fn: () => void) => {
    fn(); // warm
    const t0 = performance.now();
    for (let r = 0; r < 3; r++) for (const q of qs) void q, fn();
    console.log(`${vocab.padEnd(5)} ${label.padEnd(34)} ${((performance.now() - t0) / (3 * qs.length)).toFixed(1)} ms`);
  };
  let k = 0;
  const next = () => qs[k++ % qs.length];
  time("rankSequence", () => clf.rankSequence(next()));
  time("rankSequence + include(phrases)", () => clf.rankSequence(next(), { include: pg }));
  time("distancesFor(phrase glosses)", () => clf.distancesFor(next(), pg));
  time("distancesFor(5 glosses)", () => clf.distancesFor(next(), pg.slice(0, 5)));
  time("classifySequence", () => clf.classifySequence(next()));
}
