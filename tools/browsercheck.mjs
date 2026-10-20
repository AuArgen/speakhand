// Browser checks with playwright-core + installed Chrome (headless) against a dev server.
//   node tools/browsercheck.mjs [baseUrl=http://localhost:8796] [what=app|replay|all] [extra replay query]
// app:    RecognizePage and the room (signer) load without console errors, templates load (vocabulary > 0)
// replay: vision-replay.html runs the real tracker→segmenter→decoder pipeline on a lesson video
//         (default: lesson 3, 0–40 s, sign mode; then perturbations) and prints the summaries.
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:8796";
const what = process.argv[3] ?? "all";
const extra = process.argv[4] ?? "";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  // GPU=1: try hardware WebGL in headless Chrome (ANGLE/D3D11); default: SwiftShader (CPU, slow but deterministic)
  args: ["--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist", ...(process.env.GPU ? ["--use-gl=angle", "--use-angle=d3d11", "--enable-gpu-rasterization", "--enable-webgl", "--enable-accelerated-2d-canvas"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const errors = [];
function watch(page, tag) {
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${tag}: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${tag}: pageerror ${e.message}`));
}

async function appChecks() {
  // RecognizePage
  const page = await ctx.newPage();
  watch(page, "recognize");
  await page.goto(`${base}/#/recognize`, { waitUntil: "load" });
  await page.waitForFunction(() => /\d+ жест/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {});
  const recText = await page.evaluate(() => document.body.innerText);
  const vocab = /(\d+) жест/.exec(recText)?.[1];
  console.log(`recognize page: vocabulary ${vocab ?? "?"} · loading text present: ${/жүктөлүүдө/.test(recText)}`);
  await page.screenshot({ path: "shots/check-recognize.png" });

  // Room as signer
  const res = await page.request.post(`${base}/api/rooms`, { data: { role: "speaker", name: "test", clientId: "chk-speaker" } });
  const room = await res.json();
  const code = room.code ?? room.room?.code;
  const page2 = await ctx.newPage();
  watch(page2, "room");
  await page2.goto(`${base}/#/r/${code}`, { waitUntil: "load" });
  const signerBtn = page2.getByRole("radio", { name: /жаңс|signer/i }).first();
  if (await signerBtn.count()) await signerBtn.click();
  else await page2.locator(".role-cards button").nth(1).click();
  const nameInput = page2.locator("input[type=text]").first();
  if (await nameInput.count() && !(await nameInput.inputValue())) await nameInput.fill("Тест");
  const go = page2.getByRole("button", { name: /кир|улант|бөлмө/i }).first();
  if (await go.count()) await go.click().catch(() => {});
  await page2.waitForFunction(() => /[1-9]\d* жест/.test(document.body.innerText), null, { timeout: 90_000 }).catch(() => {});
  const roomText = await page2.evaluate(() => document.body.innerText);
  console.log(`room (signer) page: vocabulary chip ${/(\d+) жест/.exec(roomText)?.[1] ?? "?"} · camera button: ${/Камераны күйгүзүү/.test(roomText)} · code ${code}`);
  await page2.screenshot({ path: "shots/check-room-signer.png" });
}

async function replayRun(query) {
  const page = await ctx.newPage();
  watch(page, `replay ${query}`);
  await page.goto(`${base}/vision-replay.html?${query}&autorun=1`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__replay && window.__replay.done, null, { timeout: 600_000 });
  const st = await page.evaluate(() => ({ status: window.__replay.status, summary: window.__replay.summary, fps: window.__replay.fps, frames: window.__replay.frames, timing: window.__replay.timing, error: window.__replay.error, log: document.getElementById("log").textContent }));
  console.log(`\n[${query}] ${st.status}`);
  console.log(`  summary: ${JSON.stringify(st.summary)} · last timing: ${JSON.stringify(st.timing)}`);
  if (process.env.VERBOSE) console.log(st.log);
  await page.screenshot({ path: `shots/replay-${query.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.png` });
  await page.close();
}

try {
  if (what === "app" || what === "all") await appChecks();
  if (what === "replay" || what === "all") {
    const runs = extra
      ? [extra]
      : [
          "lesson=3&from=0&to=40&mode=sign&vocab=conv",
          "lesson=3&from=0&to=40&mode=sign&vocab=conv&perturb=flip",
          "lesson=3&from=0&to=40&mode=sign&vocab=conv&perturb=zoom1.3",
          "lesson=3&from=0&to=40&mode=sign&vocab=conv&perturb=shift0.12",
          "lesson=3&from=0&to=40&mode=sign&vocab=conv&perturb=res360",
          "lesson=3&from=0&to=40&mode=sign&vocab=conv&perturb=fps15",
          "lesson=3&from=0&to=40&mode=sign&vocab=conv&perturb=bright1.35",
          "lesson=27&from=0&to=60&mode=utterance&vocab=conv",
        ];
    for (const q of runs) await replayRun(q);
  }
} finally {
  console.log(`\nconsole errors: ${errors.length}`);
  for (const e of errors.slice(0, 20)) console.log("  " + e);
  await browser.close();
}
