// Сүйлө — сервердин кирүү чекити.
//   tsx server/index.ts [--dev] [--lan]
//   --dev  Vite middleware катары кошулат (бир порт, HMR ушул эле серверде)
//   --lan  HTTPS (өзү кол койгон сертификат, server/data/cert/) жана бардык интерфейстер —
//          телефондор камера/микрофонду коопсуз даректе гана берет.
// Чөйрө өзгөрмөлөрү: PORT (демейки 8787), HOST, DATA_DIR (бөлмөлөр үчүн туруктуу папка, мис. Railway volume),
// TRUST_PROXY=1 (прокси артында — X-Forwarded-For).
import { startServer } from "./app.ts";
import { cacheSize, phrasebookSize } from "./phrasebook.ts";

const DEV = process.argv.includes("--dev");
const LAN = process.argv.includes("--lan") || process.env.HTTPS === "1";

console.log(`✓ Даяр котормолор: ${phrasebookSize()} сүйлөм · сакталган котормолор: ${cacheSize()}`);

const PORT = Number(process.env.PORT ?? 8787);
const app = await startServer({
  port: PORT,
  host: process.env.HOST || undefined,
  dataDir: process.env.DATA_DIR || undefined,
  https: LAN,
  dev: DEV,
}).catch(
  (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`✗ ${PORT} порту бош эмес. Башка порт тандаңыз, мис.: PORT=${PORT + 1} npm run dev`);
      process.exit(1);
    }
    throw e;
  },
);

console.log(`Сүйлө: ${app.url}${DEV ? " (иштеп чыгуу режими)" : ""}`);
if (LAN) {
  const urls = app.lanUrls();
  if (urls.length) {
    console.log("Телефондон ачыңыз (ошол эле Wi-Fi):");
    for (const u of urls) console.log(`  ${u}`);
    console.log("Сертификат өзү кол коюлган — браузер эскертсе, «Баары бир өтүү» дегенди басыңыз.");
  } else {
    console.log("LAN дареги табылган жок — компьютер Wi-Fi/тармакка туташканын текшериңиз.");
  }
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  try {
    await app.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
