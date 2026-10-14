// Format-2 decoder check: decode every public/signs/rsl/clips/<id>.json with src/data/clipCodec.ts and
// compare with the format-1 lesson files kept in cache/v1/ (made by the same pipeline before v2).
//   npx tsx tools/rsl_import/roundtrip.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeClip, type EncodedClip } from "../../src/data/clipCodec";
import type { MocapClip, Vec3 } from "../../src/lib/types";

const ROOT = path.resolve(import.meta.dirname, "../..");
const RSL = path.join(ROOT, "public/signs/rsl");
const V1 = path.join(ROOT, "tools/rsl_import/cache/v1");

const man = JSON.parse(readFileSync(path.join(RSL, "manifest.json"), "utf8")) as { format: number; items: { id: string; clip: string }[] };
const v1: Record<string, MocapClip> = {};
for (let l = 1; l <= 28; l++) {
  const f = path.join(V1, `l${String(l).padStart(2, "0")}.json`);
  if (existsSync(f)) Object.assign(v1, (JSON.parse(readFileSync(f, "utf8")) as { clips: Record<string, MocapClip> }).clips);
}

let maxPos = 0, maxFace = 0, nulls = 0, frames = 0, compared = 0, gzMismatch = 0;
const pts = (a: Vec3[] | null, b: Vec3[] | null) => {
  if (!a || !b) { if (a !== b && !(a === null && b === null)) nulls++; return; }
  for (let i = 0; i < a.length; i++) for (let k = 0; k < 3; k++) maxPos = Math.max(maxPos, Math.abs(a[i][k] - b[i][k]));
};
for (const it of man.items) {
  const file = path.join(RSL, it.clip);
  const raw = readFileSync(file);
  if (!gunzipSync(readFileSync(file + ".gz")).equals(raw)) gzMismatch++;
  const dec = decodeClip(JSON.parse(raw.toString("utf8")) as EncodedClip);
  const ref = v1[it.id];
  if (!ref) continue;
  compared++;
  if (ref.frames.length !== dec.frames.length) throw new Error(`${it.id}: frame count ${dec.frames.length} != ${ref.frames.length}`);
  ref.frames.forEach((r, i) => {
    const d = dec.frames[i];
    frames++;
    if (Math.abs(r.t - d.t) > 1e-9) throw new Error(`${it.id}: t ${d.t} != ${r.t}`);
    pts(r.pose, d.pose);
    pts(r.leftHand, d.leftHand);
    pts(r.rightHand, d.rightHand);
    if (!r.face !== !d.face) nulls++;
    else if (r.face && d.face) for (const k of Object.keys(r.face)) maxFace = Math.max(maxFace, Math.abs(r.face[k] - d.face[k]));
  });
}
console.log(`format ${man.format}: ${man.items.length} clips, ${compared} compared with v1 (${frames} frames)`);
console.log(`max |Δ| position ${(maxPos * 1000).toFixed(3)} mm (quantum 0.5 mm → ≤ 0.25 mm expected), face ${maxFace.toFixed(3)}, null mismatches ${nulls}, .gz mismatches ${gzMismatch}`);
if (maxPos > 0.00026 || maxFace > 0.0051 || nulls || gzMismatch) process.exit(1);
