// Recognition templates for the whole library, computed OFFLINE with the app's own feature code
// (src/vision/features.ts) from the decoded format-2 clips — exactly what the browser would compute.
//   npx tsx tools/rsl_import/templates.ts
// Output: public/signs/rsl/templates.bin (+ .gz) and templates.json (+ .gz):
//   bin  = count × n × dims int8, row-major (row → time → dim). Values are delta-coded along time
//          per dim modulo 256 when `delta` is true (first time step absolute) — compresses ~2× better.
//   json = { version, n, dims, count, encoding: "int8", delta, scale[dims], glosses[], rows[], ids[], features }
//          value = int8 × scale[dim]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { decodeClip, type EncodedClip } from "../../src/data/clipCodec";
import { FEATURE_DIM, FEATURE_WEIGHTS, RESAMPLE_N, clipFeatures } from "../../src/vision/features";
import { SignClassifier, decodeTemplateBank, type TemplateIndex } from "../../src/vision/classifier";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RSL = path.join(ROOT, "public/signs/rsl");

interface Item { id: string; gloss: string; clip: string; quality: number }
const man = JSON.parse(readFileSync(path.join(RSL, "manifest.json"), "utf8")) as { items: Item[] };

const n = RESAMPLE_N, D = FEATURE_DIM;
const seqs: Float32Array[] = [];
const rows: number[] = [];
const ids: string[] = [];
const glosses: string[] = [];
const gIndex = new Map<string, number>();
const t0 = performance.now();
for (const it of man.items) {
  const clip = decodeClip(JSON.parse(readFileSync(path.join(RSL, it.clip), "utf8")) as EncodedClip);
  // same validity rule as SignClassifier.validClip (≥ 4 frames, ≥ 150 ms, some hand)
  if (clip.frames.length < 4 || clip.frames.at(-1)!.t - clip.frames[0].t < 150 || !clip.frames.some((f) => f.leftHand || f.rightHand)) continue;
  const seq = clipFeatures(clip);
  if (!seq) continue;
  if (!gIndex.has(it.gloss)) { gIndex.set(it.gloss, glosses.length); glosses.push(it.gloss); }
  seqs.push(seq);
  rows.push(gIndex.get(it.gloss)!);
  ids.push(it.id);
}
const featMs = performance.now() - t0;

// symmetric per-dim int8 scale
const scale = new Float32Array(D);
for (const s of seqs) for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) scale[d] = Math.max(scale[d], Math.abs(s[i * D + d]));
for (let d = 0; d < D; d++) scale[d] = scale[d] > 0 ? scale[d] / 127 : 1;

const R = seqs.length;
const q = new Int8Array(R * n * D);
let maxErr = 0;
seqs.forEach((s, r) => {
  for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) {
    const v = Math.max(-127, Math.min(127, Math.round(s[i * D + d] / scale[d])));
    q[(r * n + i) * D + d] = v;
    maxErr = Math.max(maxErr, Math.abs(v * scale[d] - s[i * D + d]));
  }
});
// delta along time (mod 256)
const delta = new Int8Array(q.length);
for (let r = 0; r < R; r++) for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) {
  const o = (r * n + i) * D + d;
  delta[o] = i === 0 ? q[o] : (((q[o] - q[o - D]) << 24) >> 24); // wrap to int8
}
const plainGz = gzipSync(Buffer.from(q.buffer), { level: 9 }).length;
const deltaGz = gzipSync(Buffer.from(delta.buffer), { level: 9 }).length;
const useDelta = deltaGz < plainGz;
const bin = Buffer.from((useDelta ? delta : q).buffer);

// Calibration prior for library classes (one template each, variants may be different signs):
// typical = 0.4 × median distance from a template to the nearest template of ANOTHER gloss (with
// rejectRatio 2 an unknown movement is accepted only if it is clearly closer than other signs usually
// are; real signers are farther from the templates than synthetic perturbations, so not stricter),
// temperature = 0.25 × typical (same rule as SignClassifier.tempScale). Computed on the quantised bank.
function calibrate(): { typical: number; temperature: number; nearestOtherMedian: number } {
  const tmp = { version: 1, n, dims: D, count: R, encoding: "int8" as const, delta: useDelta, scale: Array.from(scale), glosses, rows };
  const bank = decodeTemplateBank(tmp as TemplateIndex, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
  const clf = new SignClassifier();
  const size = n * D;
  const sample = Array.from({ length: Math.min(160, R) }, (_, i) => Math.floor((i * R) / Math.min(160, R)));
  const nearest: number[] = [];
  for (const a of sample) {
    let best = Infinity;
    const qa = bank.data.subarray(a * size, (a + 1) * size);
    for (let b = 0; b < R; b++) if (rows[b] !== rows[a]) best = Math.min(best, clf.distance(qa, bank.data.subarray(b * size, (b + 1) * size)));
    nearest.push(best);
  }
  nearest.sort((x, y) => x - y);
  const med = nearest[nearest.length >> 1];
  const typical = +(0.4 * med).toFixed(4);
  return { typical, temperature: +(0.25 * typical).toFixed(4), nearestOtherMedian: +med.toFixed(4) };
}
const t2 = performance.now();
const calib = calibrate();
console.log(`calibration (${(performance.now() - t2).toFixed(0)} ms): nearest other gloss median ${calib.nearestOtherMedian} → typical ${calib.typical}, temperature ${calib.temperature}`);

const index = {
  version: 1,
  calib: { typical: calib.typical, temperature: calib.temperature },
  n, dims: D, count: R,
  encoding: "int8",
  delta: useDelta,
  scale: Array.from(scale, (x) => +x.toPrecision(7)),
  glosses,
  rows,
  ids,
  // the client compares this with its own feature code and ignores a stale bank
  features: { n: RESAMPLE_N, dim: FEATURE_DIM, weights: FEATURE_WEIGHTS },
};
const json = JSON.stringify(index);
writeFileSync(path.join(RSL, "templates.bin"), bin);
writeFileSync(path.join(RSL, "templates.bin.gz"), gzipSync(bin, { level: 9 }));
writeFileSync(path.join(RSL, "templates.json"), json);
writeFileSync(path.join(RSL, "templates.json.gz"), gzipSync(Buffer.from(json), { level: 9 }));
console.log(`${R} templates (${glosses.length} glosses), features ${featMs.toFixed(0)} ms, int8 max err ${maxErr.toFixed(4)}`);
console.log(`bin ${(bin.length / 1e6).toFixed(2)} MB; gz plain ${(plainGz / 1e6).toFixed(2)} MB, delta ${(deltaGz / 1e6).toFixed(2)} MB → ${useDelta ? "delta" : "plain"}; json ${(json.length / 1024).toFixed(0)} KB, gz ${(gzipSync(Buffer.from(json)).length / 1024).toFixed(0)} KB`);
