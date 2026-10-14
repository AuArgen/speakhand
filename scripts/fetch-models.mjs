#!/usr/bin/env node
// MediaPipe моделдерин public/models/ ичине жүктөйт жана WASM файлдарын public/mediapipe-wasm/ ичине көчүрөт.
// Мурунтан бар файлдар өткөрүлүп жиберилет. Колдонуу: node scripts/fetch-models.mjs [--force]
import { createWriteStream, existsSync, mkdirSync, copyFileSync, statSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(root, "public", "models");
const wasmDir = join(root, "public", "mediapipe-wasm");
const force = process.argv.includes("--force");

const BASE = "https://storage.googleapis.com/mediapipe-models";
const MODELS = [
  ["hand_landmarker.task", `${BASE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`],
  ["pose_landmarker_lite.task", `${BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`],
  ["pose_landmarker_full.task", `${BASE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`],
  ["face_landmarker.task", `${BASE}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`],
];

function present(p) {
  try { return statSync(p).size > 1024; } catch { return false; }
}

async function download(url, dest) {
  const tmp = dest + ".part";
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, dest);
  return statSync(dest).size;
}

async function main() {
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(wasmDir, { recursive: true });
  let failed = 0;
  for (const [name, url] of MODELS) {
    const dest = join(modelsDir, name);
    if (!force && present(dest)) { console.log(`✓ ${name} (бар)`); continue; }
    process.stdout.write(`↓ ${name} … `);
    try {
      const size = await download(url, dest);
      console.log(`${(size / 1e6).toFixed(1)} MB`);
    } catch (e) {
      failed++;
      console.log(`КАТА: ${e instanceof Error ? e.message : e}`);
      try { unlinkSync(dest + ".part"); } catch { /* ignore */ }
    }
  }
  const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  if (!existsSync(src)) {
    console.error("node_modules/@mediapipe/tasks-vision/wasm табылган жок — алгач `npm install` кылыңыз");
    process.exit(1);
  }
  for (const f of readdirSync(src)) {
    const dest = join(wasmDir, f);
    const s = statSync(join(src, f));
    if (!force && existsSync(dest) && statSync(dest).size === s.size) { console.log(`✓ mediapipe-wasm/${f} (бар)`); continue; }
    copyFileSync(join(src, f), dest);
    console.log(`→ mediapipe-wasm/${f}`);
  }
  if (failed) { console.error(`${failed} модель жүктөлгөн жок`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
