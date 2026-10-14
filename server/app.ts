// Сүйлө — backend. Node'дун өзүнүн http модулу, кошумча фреймворк жок.
// startServer() — бир функция: API + бөлмөлөр (WebSocket) + Vite (иштеп чыгууда) же dist (продакшн).
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { checkClaudeCli, CLAUDE_MODELS, type ClaudeModel } from "./claude.ts";
import { glossWithClaude, glossWithRules, sentenceWithClaude, sentenceWithRules, type VocabItem } from "./gloss.ts";
import { createDualServer, ensureCert, lanUrls, type TlsPair } from "./lan.ts";
import {
  bindToVocabulary,
  cacheSize,
  listPhrases,
  lookupCache,
  lookupPhrase,
  phrasebookSize,
  rememberTranslation,
} from "./phrasebook.ts";
import { cleanName, isRole, RoomHub, RoomStore, type RoomHubOptions, type RoomStoreOptions } from "./rooms.ts";
import { tryServeGzip } from "./static-gz.ts";
import { clientIp } from "./net.ts";
import { withClientVocabulary } from "./vocabulary.ts";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(SERVER_DIR, "../dist");
export const DEFAULT_DATA_DIR = path.join(SERVER_DIR, "data");
const TTS_URL = process.env.TTS_URL ?? "http://127.0.0.1:8790";

let claudeVersion: string | null = null;

async function readJson<T>(req: IncomingMessage, limit = 1_000_000): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "Сурам өтө чоң");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "JSON туура эмес");
  }
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function ttsAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

type GlossMode = "auto" | "offline" | "ai";

/**
 * Котормо тартиби — AI акыркы жол:
 * 1) даяр котормо китепчеси → 2) мурун Claude которгон (дисктеги кэш) →
 * 3) эрежелер, эгер бардык сөз сөздүктө болсо (auto) → 4) Claude (жаңы сүйлөм, натыйжа кэшке жазылат).
 * offline — Claude эч качан чакырылбайт; ai — кэш болбосо дайыма Claude.
 */
async function handleGloss(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<{ text?: string; vocabulary?: VocabItem[]; model?: string; mode?: GlossMode }>(req);
  const text = (body.text ?? "").trim();
  if (!text) throw new HttpError(400, "Текст бош");
  if (text.length > 1000) throw new HttpError(400, "Текст өтө узун (1000 белгиге чейин)");
  // Китепкана + демо сервердин өзүндө; кардар өз жаздырууларын гана жиберет.
  const vocab = withClientVocabulary(
    (body.vocabulary ?? [])
      .filter((v) => typeof v?.gloss === "string")
      .slice(0, 2000)
      .map((v) => ({ gloss: v.gloss, aliases: Array.isArray(v.aliases) ? v.aliases.filter((a) => typeof a === "string") : [] })),
  );
  const model: ClaudeModel = CLAUDE_MODELS.includes(body.model as ClaudeModel) ? (body.model as ClaudeModel) : "sonnet";
  const mode: GlossMode = body.mode === "offline" || body.mode === "ai" ? body.mode : "auto";

  const phrase = lookupPhrase(text);
  if (phrase) return send(res, 200, bindToVocabulary(phrase, vocab, "phrasebook"));

  const cached = lookupCache(text);
  if (cached) return send(res, 200, bindToVocabulary(cached, vocab, "cache", cached.model));

  const rules = glossWithRules(text, vocab);
  if (mode === "offline" || !claudeVersion) {
    return send(res, 200, { ...rules, warning: mode === "offline" || claudeVersion ? undefined : "Claude CLI жок" });
  }
  // Бардык сөз сөздүктөн табылып, сүйлөм кыска болсо — эрежелер жетиштүү.
  const words = text.split(/\s+/).filter(Boolean).length;
  if (mode === "auto" && rules.fingerspell.length === 0 && rules.gloss.length > 0 && words <= 6) {
    return send(res, 200, rules);
  }

  try {
    const out = await glossWithClaude(text, vocab, model);
    rememberTranslation(text, out.raw, out.model);
    send(res, 200, { ...bindToVocabulary(out.raw, vocab, "claude", out.model), ms: out.ms });
  } catch (e) {
    console.warn("Claude котормосу ишке ашкан жок:", (e as Error).message);
    send(res, 200, { ...rules, warning: (e as Error).message });
  }
}

async function handleSentence(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<{ gloss?: string[]; question?: boolean; model?: string }>(req, 50_000);
  const gloss = (body.gloss ?? []).filter((g) => typeof g === "string" && g.trim()).slice(0, 60);
  if (!gloss.length) throw new HttpError(400, "Глосс бош");
  const question = Boolean(body.question);
  const model: ClaudeModel = CLAUDE_MODELS.includes(body.model as ClaudeModel) ? (body.model as ClaudeModel) : "sonnet";
  if (!claudeVersion) return send(res, 200, { sentence: sentenceWithRules(gloss, question), engine: "rules" });
  try {
    const out = await sentenceWithClaude(gloss, question, model);
    send(res, 200, { ...out, engine: "claude" });
  } catch (e) {
    send(res, 200, { sentence: sentenceWithRules(gloss, question), engine: "rules", warning: (e as Error).message });
  }
}

async function handleTts(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<{ text?: string }>(req, 20_000);
  const text = (body.text ?? "").trim().slice(0, 600);
  if (!text) throw new HttpError(400, "Текст бош");
  let r: Response;
  try {
    r = await fetch(`${TTS_URL}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(503, "Кыргызча TTS кызматы иштеген жок (tts/run.ps1)");
  }
  if (!r.ok) throw new HttpError(502, `TTS ката: ${r.status}`);
  res.writeHead(200, { "content-type": r.headers.get("content-type") ?? "audio/wav" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, "Дарек туура эмес");
  }
  let file = path.join(DIST, pathname);
  if (!file.startsWith(DIST)) throw new HttpError(403, "Тыюу салынган");
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(DIST, "index.html"); // SPA
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    throw new HttpError(404, "Табылган жок. Алгач `npm run build` аткарыңыз.");
  }
}

/** IP боюнча жөнөкөй чектөө (бөлмө кодун тандап табууга жана спамга каршы). */
class IpLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  allow(ip: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(ip, list);
      return false;
    }
    list.push(now);
    this.hits.set(ip, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export interface StartOptions {
  /** 0 — кокустук бош порт. Демейки: PORT же 8787 */
  port?: number;
  /** Тыңшоо дареги. Демейки: бардык интерфейстер */
  host?: string;
  /** Бөлмөлөр (<dataDir>/rooms) жана сертификат (<dataDir>/cert) үчүн папка. Демейки: server/data */
  dataDir?: string;
  /** true — өзү кол койгон сертификат (<dataDir>/cert), же даяр { key, cert } */
  https?: boolean | TlsPair;
  /** Vite'ты middleware катары кошуу (иштеп чыгуу режими) */
  dev?: boolean;
  /** Claude CLI бар-жогун текшерүү. Демейки: true */
  claude?: boolean;
  /** Консолго жазуу. Демейки: true */
  log?: boolean;
  /** Тесттер үчүн: бөлмө сактагычынын жана хабдын жөндөөлөрү */
  rooms?: Partial<Omit<RoomStoreOptions, "dir">> & RoomHubOptions;
}

export interface RunningServer {
  port: number;
  https: boolean;
  /** http(s)://localhost:<port> */
  url: string;
  server: HttpServer | HttpsServer;
  store: RoomStore;
  hub: RoomHub;
  lanUrls(): string[];
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const log = opts.log === false ? () => {} : (m: string) => console.log(m);
  const warn = opts.log === false ? () => {} : (m: string) => console.warn(m);
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const port = opts.port ?? Number(process.env.PORT ?? 8787);

  if (opts.claude !== false) {
    checkClaudeCli().then((v) => {
      claudeVersion = v;
      log(v ? `✓ Claude CLI: ${v}` : "ℹ AI (Claude CLI) жок — AI'сыз режим: даяр котормолор + сөздүк эрежелери (бул кадимки абал)");
    });
  }

  const store = new RoomStore({ ...opts.rooms, dir: path.join(dataDir, "rooms"), log: warn });
  await store.init();
  const hub = new RoomHub(store, { ...opts.rooms, log: warn });

  const tls: TlsPair | null =
    opts.https === true ? await ensureCert(path.join(dataDir, "cert"), log) : opts.https ? opts.https : null;
  const isHttps = Boolean(tls);
  let actualPort = port;
  const createLimiter = new IpLimiter(30, 60_000);
  const checkLimiter = new IpLimiter(120, 60_000);

  // Vite керек болсо, ал серверге кийин кошулат (handler ичинде колдонулат).
  let vite: import("vite").ViteDevServer | null = null;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const rawUrl = req.url ?? "/";
      const pathname = rawUrl.split("?")[0];
      const method = req.method ?? "GET";
      const ip = clientIp(req);
      if (pathname === "/api/health" && method === "GET") {
        return send(res, 200, {
          ok: true,
          claude: claudeVersion,
          models: CLAUDE_MODELS,
          tts: await ttsAvailable(),
          phrasebook: phrasebookSize(),
          cached: cacheSize(),
        });
      }
      if (pathname === "/api/gloss" && method === "POST") return await handleGloss(req, res);
      if (pathname === "/api/sentence" && method === "POST") return await handleSentence(req, res);
      if (pathname === "/api/tts" && method === "POST") return await handleTts(req, res);
      if (pathname === "/api/rooms" && method === "POST") {
        if (!createLimiter.allow(ip)) throw new HttpError(429, "Өтө көп бөлмө ачылды — бир аздан кийин аракет кылыңыз");
        const body = await readJson<{ role?: unknown; name?: unknown; clientId?: unknown }>(req, 10_000);
        if (!body || typeof body !== "object") throw new HttpError(400, "JSON объект күтүлөт");
        if (!isRole(body.role)) throw new HttpError(400, "role: speaker же signer");
        const clientId =
          typeof body.clientId === "string" && body.clientId && body.clientId.length <= 64 ? body.clientId : undefined;
        const room = store.create(body.role, cleanName(body.name), clientId);
        return send(res, 200, room.summary());
      }
      const roomMatch = /^\/api\/rooms\/([^/]+)$/.exec(pathname);
      if (roomMatch && method === "GET") {
        if (!checkLimiter.allow(ip)) throw new HttpError(429, "Өтө көп суроо — бир аздан кийин аракет кылыңыз");
        const room = store.get(roomMatch[1]);
        if (!room) throw new HttpError(404, "Мындай бөлмө жок");
        return send(res, 200, room.summary());
      }
      if (pathname === "/api/phrases" && method === "GET") return send(res, 200, { items: listPhrases() });
      if (pathname === "/api/net" && method === "GET") {
        return send(res, 200, { urls: lanUrls(isHttps, actualPort), https: isHttps });
      }
      if (pathname.startsWith("/api/")) throw new HttpError(404, "Мындай API жок");
      if (method === "GET" && (await tryServeGzip(req, res))) return;
      if (vite) return vite.middlewares(req, res);
      return await serveStatic(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: (e as Error).message });
      else res.end();
    }
  };

  const dual = tls ? createDualServer(tls, handler) : null;
  const server: HttpServer | HttpsServer = dual ? dual.https : createServer(handler);
  const listener = dual ? dual.tcp : server;

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (hub.handleUpgrade(req, socket, head)) return;
    // Vite HMR өзүнүн upgrade угуучусунда иштетет; калганын жабабыз.
    const proto = String(req.headers["sec-websocket-protocol"] ?? "");
    if (vite && (proto === "vite-hmr" || proto === "vite-ping")) return;
    socket.destroy();
  });

  if (opts.dev) {
    const { createServer: createViteServer } = await import("vite");
    // HMR ушул эле серверде (бөлөк 24678 порту жок) — бир нече нуска ар башка портто чогуу иштей алат.
    vite = await createViteServer({
      server: { middlewareMode: true, ws: { server: server as HttpServer } },
      appType: "spa",
    });
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    listener.once("error", onError);
    listener.listen({ port, host: opts.host }, () => {
      listener.off("error", onError);
      resolve();
    });
  });
  actualPort = (listener.address() as AddressInfo).port;
  listener.on("error", (e) => warn(`Сервер катасы: ${e.message}`));

  let closed: Promise<void> | null = null;
  return {
    port: actualPort,
    https: isHttps,
    url: `${isHttps ? "https" : "http"}://localhost:${actualPort}`,
    server,
    store,
    hub,
    lanUrls: () => lanUrls(isHttps, actualPort),
    close() {
      closed ??= (async () => {
        await hub.close();
        await vite?.close();
        await new Promise<void>((r) => {
          listener.close(() => r());
          if (dual) dual.destroyAll();
          else (server as HttpServer).closeAllConnections();
        });
        await store.close();
      })();
      return closed;
    },
  };
}
