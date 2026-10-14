// Бөлмөлөрдүн тести: npx tsx server/rooms.test.ts
// Чыныгы сервер (Vite'сыз) убактылуу папка менен кокустук портто ишке кирет;
// Node 24'түн глобалдык WebSocket'и менен «speaker» жана «signer» туураланат.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { get as httpsGet, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { WebSocket as WsClient } from "ws";
import { startServer, type RunningServer, type StartOptions } from "./app.ts";
import type { ClientEvent, RoomMessage, RoomSummary, ServerEvent } from "../src/lib/room.ts";

let dataDir = "";
let srv: RunningServer;
const extraServers: RunningServer[] = [];

const BASE_OPTS: StartOptions = { claude: false, log: false, rooms: { saveDelayMs: 20 } };

function start(opts: Partial<StartOptions> = {}) {
  return startServer({ ...BASE_OPTS, port: 0, dataDir, ...opts, rooms: { ...BASE_OPTS.rooms, ...opts.rooms } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// WebSocket жардамчысы: келген окуяларды кезекке топтойт.

class Sock {
  readonly events: ServerEvent[] = [];
  private waiters: (() => void)[] = [];
  closed: Promise<{ code: number; reason: string }>;
  isClosed = false;

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (e: MessageEvent) => {
      this.events.push(JSON.parse(String(e.data)) as ServerEvent);
      this.wake();
    });
    this.closed = new Promise((resolve) =>
      ws.addEventListener("close", (e: CloseEvent) => {
        this.isClosed = true;
        resolve({ code: e.code, reason: e.reason });
        this.wake();
      }),
    );
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  static open(url: string): Promise<Sock> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const s = new Sock(ws);
      ws.addEventListener("open", () => resolve(s), { once: true });
      ws.addEventListener("error", () => reject(new Error(`WebSocket ачылган жок: ${url}`)), { once: true });
    });
  }

  send(ev: ClientEvent | Record<string, unknown> | string) {
    this.ws.send(typeof ev === "string" ? ev : JSON.stringify(ev));
  }

  /** Шартка дал келген биринчи окуяны кезектен алып кайтарат (күтөт). */
  async next<T extends ServerEvent = ServerEvent>(pred: (e: ServerEvent) => boolean = () => true, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.events.findIndex(pred);
      if (i >= 0) return this.events.splice(i, 1)[0] as T;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Окуя келген жок. Кезекте: ${JSON.stringify(this.events)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  nextOf<K extends ServerEvent["t"]>(t: K, ms?: number) {
    return this.next<Extract<ServerEvent, { t: K }>>((e) => e.t === t, ms);
  }

  /** ms ичинде шартка дал келген окуя келбеши керек. */
  async expectNone(pred: (e: ServerEvent) => boolean, ms = 250) {
    await sleep(ms);
    const found = this.events.find(pred);
    assert.equal(found, undefined, `Күтүлбөгөн окуя: ${JSON.stringify(found)}`);
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

const wsUrl = () => `${srv.url.replace(/^http/, "ws")}/ws`;

async function join(code: string, clientId: string, role: "speaker" | "signer", name: string, lastSeq?: number) {
  const s = await Sock.open(wsUrl());
  s.send({ t: "hello", room: code, clientId, name, role, ...(lastSeq !== undefined ? { lastSeq } : {}) });
  const welcome = await s.nextOf("welcome");
  return { s, welcome };
}

async function api<T>(p: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(`${srv.url}${p}`, init);
  return { status: r.status, body: (await r.json()) as T };
}

async function createRoomRest(role: string, name: string, clientId?: string) {
  return api<RoomSummary & { error?: string }>("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, name, clientId }),
  });
}

// ---------------------------------------------------------------------------

before(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "suylo-rooms-"));
  srv = await start();
});

after(async () => {
  await srv?.close();
  for (const s of extraServers) await s.close();
  await rm(dataDir, { recursive: true, force: true });
});

let code = "";
let speaker: Sock;
let signer: Sock;

test("REST: бөлмө ачуу, текшерүү, phrases, net, health", async () => {
  const created = await createRoomRest("speaker", "  Айбек  ", "spk-1");
  assert.equal(created.status, 200);
  assert.match(created.body.code, /^[1-9]\d{5}$/);
  assert.equal(created.body.messageCount, 0);
  assert.deepEqual(created.body.participants, [
    { clientId: "spk-1", name: "Айбек", role: "speaker", online: false, status: "idle" },
  ]);
  code = created.body.code;

  const checked = await api<RoomSummary>(`/api/rooms/${code}`);
  assert.equal(checked.status, 200);
  assert.equal(checked.body.code, code);

  const missing = code === "123456" ? "654321" : "123456";
  assert.equal((await api(`/api/rooms/${missing}`)).status, 404);
  assert.equal((await api(`/api/rooms/abc`)).status, 404);
  assert.equal((await createRoomRest("dancer", "x")).status, 400);
  const badJson = await fetch(`${srv.url}/api/rooms`, { method: "POST", body: "{" });
  assert.equal(badJson.status, 400);

  // Коддор уникалдуу жана 0 менен башталбайт
  const codes = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const r = await createRoomRest(i % 2 ? "signer" : "speaker", "");
    assert.equal(r.status, 200);
    assert.match(r.body.code, /^[1-9]\d{5}$/);
    assert.equal(r.body.participants.length, 0);
    codes.add(r.body.code);
  }
  assert.equal(codes.size, 10);

  const phrases = await api<{ items: { text: string; gloss: string[]; question: boolean; negation: boolean }[] }>(
    "/api/phrases",
  );
  assert.equal(phrases.status, 200);
  assert.ok(phrases.body.items.length > 0);
  const p0 = phrases.body.items[0];
  assert.equal(typeof p0.text, "string");
  assert.ok(Array.isArray(p0.gloss));
  assert.equal(typeof p0.question, "boolean");

  const net = await api<{ urls: string[]; https: boolean }>("/api/net");
  assert.equal(net.status, 200);
  assert.equal(net.body.https, false);
  for (const u of net.body.urls) assert.match(u, new RegExp(`^http://\\d+\\.\\d+\\.\\d+\\.\\d+:${srv.port}$`));

  const health = await api<{ ok: boolean }>("/api/health");
  assert.equal(health.body.ok, true);
  assert.equal((await api("/api/nope")).status, 404);
});

test("speaker жана signer кошулат, presence экөө тең online", async () => {
  ({ s: speaker } = await join(code, "spk-1", "speaker", "Айбек").then((r) => {
    assert.equal(r.welcome.you.clientId, "spk-1");
    assert.equal(r.welcome.you.online, true);
    assert.deepEqual(r.welcome.history, []);
    assert.equal(r.welcome.room.code, code);
    return r;
  }));
  const j = await join(code, "sgn-1", "signer", "Нургүл");
  signer = j.s;
  assert.equal(j.welcome.you.role, "signer");
  const online = j.welcome.room.participants.filter((p) => p.online).map((p) => p.clientId).sort();
  assert.deepEqual(online, ["sgn-1", "spk-1"]);

  const pres = await speaker.nextOf("presence");
  const byId = Object.fromEntries(pres.participants.map((p) => [p.clientId, p]));
  assert.equal(byId["spk-1"].online, true);
  assert.equal(byId["sgn-1"].online, true);
  assert.equal(byId["sgn-1"].name, "Нургүл");
  // Жаңы кошулган өзү presence албайт (welcome'до бар)
  await signer.expectNone((e) => e.t === "presence", 100);
});

test("билдирүүлөр эки тарапка: seq жана тартип туура", async () => {
  speaker.send({ t: "msg", id: "s1", text: "Саламатсызбы!", via: "voice" });
  const a1 = await speaker.nextOf("msg");
  const b1 = await signer.nextOf("msg");
  assert.equal(a1.msg.seq, 1);
  assert.deepEqual(a1.msg, b1.msg);
  assert.equal(a1.msg.from, "spk-1");
  assert.equal(a1.msg.name, "Айбек");
  assert.equal(a1.msg.role, "speaker");
  assert.equal(a1.msg.via, "voice");
  assert.equal(a1.msg.gloss, undefined);
  assert.ok(Math.abs(a1.msg.at - Date.now()) < 5000);

  signer.send({ t: "msg", id: "g1", text: "Салам, жакшы", gloss: ["САЛАМ", " ЖАКШЫ "], via: "sign" });
  signer.send({ t: "msg", id: "g2", text: "Рахмат", via: "quick", gloss: ["РАХМАТ"] });
  const seqA = [(await speaker.nextOf("msg")).msg, (await speaker.nextOf("msg")).msg];
  const seqB = [(await signer.nextOf("msg")).msg, (await signer.nextOf("msg")).msg];
  assert.deepEqual(
    seqA.map((m) => [m.seq, m.id]),
    [
      [2, "g1"],
      [3, "g2"],
    ],
  );
  assert.deepEqual(seqA, seqB);
  assert.deepEqual(seqA[0].gloss, ["САЛАМ", "ЖАКШЫ"]);
  assert.equal(seqA[0].role, "signer");
});

test("status башкаларга гана жиберилет", async () => {
  signer.send({ t: "status", status: "signing" });
  const st = await speaker.nextOf("status");
  assert.deepEqual(st, { t: "status", clientId: "sgn-1", status: "signing" });
  await signer.expectNone((e) => e.t === "status", 150);
  // Ошол эле абал кайталанса — кайра жиберилбейт
  signer.send({ t: "status", status: "signing" });
  await speaker.expectNone((e) => e.t === "status", 150);
  speaker.send({ t: "status", status: "typing" });
  assert.deepEqual(await signer.nextOf("status"), { t: "status", clientId: "spk-1", status: "typing" });
  speaker.send({ t: "status", status: "idle" });
  assert.equal((await signer.nextOf("status")).status, "idle");
});

test("кайталанган id (retry) экинчи жолу сакталбайт", async () => {
  speaker.send({ t: "msg", id: "s1", text: "Саламатсызбы!", via: "voice" });
  const echo = await speaker.nextOf("msg");
  assert.equal(echo.msg.seq, 1, "жөнөтүүчүгө мурунку билдирүү кайтат");
  await signer.expectNone((e) => e.t === "msg", 150);
  // Башка катышуучу ошол эле id'ни колдоно албайт
  signer.send({ t: "msg", id: "s1", text: "уурдалган id", via: "text" });
  assert.equal((await signer.nextOf("error")).code, "bad_request");

  speaker.send({ t: "msg", id: "s2", text: "Кандайсыз?", via: "text" });
  assert.equal((await signer.nextOf("msg")).msg.seq, 4);
  assert.equal((await speaker.nextOf("msg")).msg.seq, 4);
  const summary = await api<RoomSummary>(`/api/rooms/${code}`);
  assert.equal(summary.body.messageCount, 4);
});

test("үзүлүп кайра туташканда (lastSeq) өткөрүлгөндөр гана келет", async () => {
  signer.send({ t: "status", status: "typing" });
  assert.equal((await speaker.nextOf("status")).status, "typing");
  await signer.close();
  // Чыгып кеткенде status idle'га кайтат жана presence offline
  assert.deepEqual(await speaker.nextOf("status"), { t: "status", clientId: "sgn-1", status: "idle" });
  const pres = await speaker.nextOf("presence");
  const sg = pres.participants.find((p) => p.clientId === "sgn-1");
  assert.equal(sg?.online, false);
  assert.equal(sg?.status, "idle");

  speaker.send({ t: "msg", id: "s3", text: "Сиз барбы?", via: "text" });
  speaker.send({ t: "msg", id: "s4", text: "Мен күтөм", via: "text" });
  await speaker.nextOf("msg");
  await speaker.nextOf("msg");

  const j = await join(code, "sgn-1", "signer", "Нургүл", 4);
  signer = j.s;
  assert.deepEqual(
    j.welcome.history.map((m) => m.id),
    ["s3", "s4"],
  );
  assert.deepEqual(
    j.welcome.history.map((m) => m.seq),
    [5, 6],
  );
  assert.equal(j.welcome.room.messageCount, 6);
  assert.equal((await speaker.nextOf("presence")).participants.find((p) => p.clientId === "sgn-1")?.online, true);

  // lastSeq акыркы болсо — бош тарых
  const k = await join(code, "sgn-1", "signer", "Нургүл", 6);
  assert.deepEqual(k.welcome.history, []);
  // Бир эле clientId'дин экинчи өтмөгү: presence өзгөрбөйт
  await speaker.expectNone((e) => e.t === "presence", 150);
  await k.s.close();
  await speaker.expectNone((e) => e.t === "presence", 150);
});

test("сервер кайра ишке киргенде тарых сакталат", async () => {
  await speaker.close();
  await signer.close();
  const port = srv.port;
  await srv.close();
  const closedStore = srv.store;
  srv = await start({ port });
  assert.notEqual(srv.store, closedStore);
  const file = path.join(dataDir, "rooms", `${code}.json`);
  assert.ok(existsSync(file), "бөлмө файлы жазылды");
  const onDisk = JSON.parse(await readFile(file, "utf8")) as { messages: RoomMessage[]; lastSeq: number };
  assert.equal(onDisk.lastSeq, 6);
  assert.equal(onDisk.messages.length, 6);
  const leftovers = (await readdir(path.join(dataDir, "rooms"))).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);

  assert.equal(srv.store.loadedCount(), 0, "бөлмөлөр керек болгондо гана жүктөлөт");
  const summary = await api<RoomSummary>(`/api/rooms/${code}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.messageCount, 6);
  assert.deepEqual(summary.body.participants.map((p) => [p.clientId, p.online]).sort(), [
    ["sgn-1", false],
    ["spk-1", false],
  ]);

  const a = await join(code, "spk-1", "speaker", "Айбек");
  speaker = a.s;
  assert.deepEqual(
    a.welcome.history.map((m) => [m.seq, m.id]),
    [
      [1, "s1"],
      [2, "g1"],
      [3, "g2"],
      [4, "s2"],
      [5, "s3"],
      [6, "s4"],
    ],
  );
  const b = await join(code, "sgn-1", "signer", "Нургүл", 6);
  signer = b.s;
  signer.send({ t: "msg", id: "g3", text: "Улантабыз", via: "sign", gloss: ["УЛАНТ"] });
  assert.equal((await speaker.nextOf("msg")).msg.seq, 7);
  // Ошол эле id рестарттан кийин да кайталанбайт
  speaker.send({ t: "msg", id: "s4", text: "Мен күтөм", via: "text" });
  assert.equal((await speaker.nextOf("msg")).msg.seq, 6);
  await signer.expectNone((e) => e.t === "msg" && e.msg.id === "s4", 150);
});

test("not_found: жок бөлмөгө hello", async () => {
  let missing = "123456";
  while (existsSync(path.join(dataDir, "rooms", `${missing}.json`))) missing = String(Number(missing) + 1);
  const s = await Sock.open(wsUrl());
  s.send({ t: "hello", room: missing, clientId: "x", name: "x", role: "speaker" });
  const err = await s.nextOf("error");
  assert.equal(err.code, "not_found");
  assert.equal((await s.closed).code, 4404);
});

test("bad_request: туура эмес билдирүүлөр серверди кулатпайт", async () => {
  const s = await Sock.open(wsUrl());
  s.send("{not json");
  assert.equal((await s.nextOf("error")).code, "bad_request");
  s.send("[1,2]");
  assert.equal((await s.nextOf("error")).code, "bad_request");
  s.send({ t: "msg", id: "z", text: "hello-сыз", via: "text" });
  assert.equal((await s.nextOf("error")).code, "bad_request");
  s.send({ t: "nope" });
  assert.equal((await s.nextOf("error")).code, "bad_request");
  s.ws.send(new Uint8Array([1, 2, 3]));
  assert.equal((await s.nextOf("error")).code, "bad_request");
  s.send({ t: "ping" });
  await s.nextOf("pong");

  // Туура эмес hello — ката жана жабылуу (4400)
  s.send({ t: "hello", room: code, clientId: "bad", name: "x", role: "dancer" });
  assert.equal((await s.nextOf("error")).code, "bad_request");
  assert.equal((await s.closed).code, 4400);

  const s2 = await Sock.open(wsUrl());
  s2.send({ t: "hello", room: "12ab", clientId: "bad", name: "x", role: "speaker" });
  assert.equal((await s2.nextOf("error")).code, "bad_request");
  assert.equal((await s2.closed).code, 4400);

  const s3 = await Sock.open(wsUrl());
  s3.send({ t: "hello", room: code, clientId: "bad", name: "x", role: "signer", lastSeq: -1 });
  assert.equal((await s3.nextOf("error")).code, "bad_request");

  // Кошулгандан кийинки туура эмес msg/status — сокет ачык калат
  const { s: c } = await join(code, "spk-1", "speaker", "Айбек");
  const bad: Record<string, unknown>[] = [
    { t: "msg", id: "long", text: "а".repeat(2001), via: "text" },
    { t: "msg", id: "gl", text: "x", gloss: Array.from({ length: 61 }, () => "А"), via: "sign" },
    { t: "msg", id: "gl2", text: "x", gloss: "САЛАМ", via: "sign" },
    { t: "msg", id: "gl3", text: "x", gloss: [1, 2], via: "sign" },
    { t: "msg", id: "", text: "x", via: "text" },
    { t: "msg", id: "i".repeat(65), text: "x", via: "text" },
    { t: "msg", id: "v", text: "x", via: "telepathy" },
    { t: "msg", id: "e", text: "   ", via: "text" },
    { t: "msg", id: "n", text: 5, via: "text" },
    { t: "status", status: "dancing" },
    { t: "hello", room: code, clientId: "spk-1", name: "x", role: "speaker" },
  ];
  for (const ev of bad) {
    c.send(ev);
    const err = await c.nextOf("error");
    assert.equal(err.code, "bad_request", JSON.stringify(ev).slice(0, 80));
    assert.ok(err.message.length > 0);
  }
  // Чек ичиндегилер өтөт: так 2000 белги, 60 глосс
  c.send({ t: "msg", id: "max", text: "б".repeat(2000), gloss: Array.from({ length: 60 }, () => "Б"), via: "sign" });
  const ok = await c.nextOf("msg");
  assert.equal(ok.msg.text.length, 2000);
  assert.equal(ok.msg.gloss?.length, 60);
  assert.equal(c.isClosed, false);
  await c.close();
});

test("rate_limited: 10 секундда 20дан ашык билдирүү", async () => {
  const r = await createRoomRest("speaker", "Тез");
  const { s } = await join(r.body.code, "fast-1", "speaker", "Тез");
  for (let i = 0; i < 25; i++) s.send({ t: "msg", id: `f${i}`, text: `билдирүү ${i}`, via: "text" });
  const msgs: RoomMessage[] = [];
  const errors: string[] = [];
  const deadline = Date.now() + 3000;
  while (msgs.length + errors.length < 25 && Date.now() < deadline) {
    const e = await s.next((x) => x.t === "msg" || x.t === "error");
    if (e.t === "msg") msgs.push(e.msg);
    else if (e.t === "error") errors.push(e.code);
  }
  assert.equal(msgs.length, 20);
  assert.deepEqual(errors, Array(5).fill("rate_limited"));
  assert.deepEqual(
    msgs.map((m) => m.seq),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  // Кабыл алынбаганын кайра жөнөтсө (чек бошогондо) — өтөт; кабыл алынганын кайра жөнөтсө — кайталанбайт
  s.send({ t: "msg", id: "f0", text: "билдирүү 0", via: "text" });
  assert.equal((await s.nextOf("msg")).msg.seq, 1);
  await s.close();
});

test("room_full: 8 катышуучу online болсо 9-су кире албайт; offline орун бошотулат", async () => {
  const r = await createRoomRest("speaker", "Чоң бөлмө");
  const c = r.body.code;
  const socks: Sock[] = [];
  for (let i = 0; i < 8; i++) socks.push((await join(c, `p${i}`, i % 2 ? "signer" : "speaker", `Адам ${i}`)).s);
  const ninth = await Sock.open(wsUrl());
  ninth.send({ t: "hello", room: c, clientId: "p8", name: "Тогузунчу", role: "speaker" });
  assert.equal((await ninth.nextOf("error")).code, "room_full");
  assert.equal((await ninth.closed).code, 4409);
  // Мурунку катышуучу кайра кире алат (жаңы өтмөк)
  const again = await join(c, "p3", "signer", "Адам 3");
  await again.s.close();

  await socks[0].close();
  await socks[1].next(
    (e) => e.t === "presence" && e.participants.some((p) => p.clientId === "p0" && !p.online),
  );
  const late = await join(c, "p8", "speaker", "Тогузунчу");
  assert.equal(late.welcome.room.participants.length, 8);
  assert.ok(!late.welcome.room.participants.some((p) => p.clientId === "p0"), "эң эски offline чыгарылды");
  await late.s.close();
  for (const s of socks.slice(1)) await s.close();
});

test("тарыхтын чеги: 1000 сакталат, welcome'до 200 (же lastSeq'тен кийинкилер)", async () => {
  const big = await start({ rooms: { msgRate: 100_000 } });
  extraServers.push(big);
  const r = await fetch(`${big.url}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "signer", name: "Көп" }),
  });
  const c = ((await r.json()) as RoomSummary).code;
  const url = `${big.url.replace(/^http/, "ws")}/ws`;
  const s = await Sock.open(url);
  s.send({ t: "hello", room: c, clientId: "many", name: "Көп", role: "signer" });
  await s.nextOf("welcome");
  const N = 1010;
  for (let i = 1; i <= N; i++) s.send({ t: "msg", id: `m${i}`, text: `#${i}`, via: "text" });
  for (let i = 1; i <= N; i++) assert.equal((await s.nextOf("msg", 10_000)).msg.seq, i);

  const s2 = await Sock.open(url);
  s2.send({ t: "hello", room: c, clientId: "reader", name: "Окуучу", role: "speaker" });
  const w = await s2.nextOf("welcome");
  assert.equal(w.history.length, 200);
  assert.equal(w.history[0].seq, N - 199);
  assert.equal(w.history.at(-1)?.seq, N);
  assert.equal(w.room.messageCount, N);

  const s3 = await Sock.open(url);
  s3.send({ t: "hello", room: c, clientId: "reader", name: "Окуучу", role: "speaker", lastSeq: 0 });
  const w3 = await s3.nextOf("welcome");
  assert.equal(w3.history.length, 1000);
  assert.equal(w3.history[0].seq, N - 999);

  const s4 = await Sock.open(url);
  s4.send({ t: "hello", room: c, clientId: "reader", name: "Окуучу", role: "speaker", lastSeq: N - 5 });
  const w4 = await s4.nextOf("welcome");
  assert.deepEqual(
    w4.history.map((m) => m.seq),
    [N - 4, N - 3, N - 2, N - 1, N],
  );
  for (const x of [s, s2, s3, s4]) await x.close();
});

test("30 күн аракетсиз бөлмөлөр өчүрүлөт", async () => {
  const roomsDir = path.join(dataDir, "rooms");
  const oldCode = "100001";
  const now = Date.now();
  const stale = {
    v: 1,
    code: oldCode,
    createdAt: now - 40 * 86400_000,
    updatedAt: now - 31 * 86400_000,
    lastSeq: 0,
    participants: [],
    messages: [],
  };
  const f = path.join(roomsDir, `${oldCode}.json`);
  await writeFile(f, JSON.stringify(stale));
  const old = new Date(now - 31 * 86400_000);
  await utimes(f, old, old);
  // Активдүү бөлмө тийбейт
  const activeFile = path.join(roomsDir, `${code}.json`);
  const deleted = await srv.store.sweep();
  assert.deepEqual(deleted, [oldCode]);
  assert.equal(existsSync(f), false);
  assert.equal(existsSync(activeFile), true);
  assert.equal((await api(`/api/rooms/${oldCode}`)).status, 404);
});

test("бузулган файл серверди кулатпайт", async () => {
  const badCode = "100002";
  await writeFile(path.join(dataDir, "rooms", `${badCode}.json`), "{ broken");
  assert.equal((await api(`/api/rooms/${badCode}`)).status, 404);
  const s = await Sock.open(wsUrl());
  s.send({ t: "hello", room: badCode, clientId: "x", name: "x", role: "speaker" });
  assert.equal((await s.nextOf("error")).code, "not_found");
});

// ---------------------------------------------------------------------------
// RoomClient (src/lib/room.ts) — Node'до браузерди туурайбыз: location + localStorage.

test("RoomClient: туташуу, билдирүү, status, кезек, кайра туташуу, not_found", async () => {
  await speaker.close();
  await signer.close();
  const mem = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: fakeStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", { value: new URL(srv.url + "/"), configurable: true, writable: true });

  const lib = await import("../src/lib/room.ts");
  const { RoomClient, createRoom, checkRoom, getClientId, fetchPhrases, fetchNetInfo } = lib;

  const idA = getClientId();
  assert.ok(idA.length >= 8);
  assert.equal(getClientId(), idA, "ID туруктуу");

  const room = await createRoom("speaker", "Айбек");
  assert.match(room.code, /^[1-9]\d{5}$/);
  assert.equal(room.participants[0]?.clientId, idA);
  assert.equal(await checkRoom("12"), null);
  assert.equal((await checkRoom(room.code.slice(0, 3) + " " + room.code.slice(3)))?.code, room.code);
  const phrases = await fetchPhrases();
  assert.ok(phrases.length > 0);
  const net = await fetchNetInfo();
  assert.equal(net.https, false);

  type Ev = { type: string; data: unknown };
  const record = (c: InstanceType<typeof RoomClient>) => {
    const log: Ev[] = [];
    for (const type of ["state", "welcome", "message", "presence", "status", "error"] as const) {
      c.on(type, (data) => log.push({ type, data }));
    }
    return log;
  };
  const waitFor = async (log: Ev[], pred: (e: Ev) => boolean, ms = 8000, from = 0) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = log.slice(from).find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`RoomClient окуясы келген жок: ${JSON.stringify(log.slice(from))}`);
      await sleep(20);
    }
  };

  const a = new RoomClient({ code: room.code, name: "Айбек", role: "speaker" });
  const logA = record(a);
  assert.equal(a.state, "closed");
  a.connect();
  assert.equal(a.state, "connecting");
  const wA = (await waitFor(logA, (e) => e.type === "welcome")).data as { history: RoomMessage[] };
  assert.deepEqual(wA.history, []);
  assert.equal(a.state, "open");
  assert.deepEqual(
    logA.filter((e) => e.type === "state").map((e) => e.data),
    ["connecting", "open"],
  );

  // Экинчи «түзмөк»: башка clientId
  mem.delete("suylo.clientId");
  const idB = getClientId();
  assert.notEqual(idB, idA);
  const b = new RoomClient({ code: room.code, name: "Нургүл", role: "signer" });
  const logB = record(b);
  b.connect();
  await waitFor(logB, (e) => e.type === "welcome");
  const pres = await waitFor(
    logA,
    (e) => e.type === "presence" && (e.data as { clientId: string; online: boolean }[]).some((p) => p.clientId === idB && p.online),
  );
  assert.ok(pres);

  // Билдирүү: жөнөтүүчүгө да кайтат (id боюнча «жөнөтүлдү»)
  const { id } = a.send("Саламатсызбы!", { via: "voice" });
  const gotB = (await waitFor(logB, (e) => e.type === "message")).data as RoomMessage;
  const gotA = (await waitFor(logA, (e) => e.type === "message")).data as RoomMessage;
  assert.equal(gotB.id, id);
  assert.equal(gotA.id, id);
  assert.equal(gotA.seq, 1);
  assert.equal(gotB.text, "Саламатсызбы!");

  b.send("Салам", { via: "sign", gloss: ["САЛАМ"] });
  const fromB = (await waitFor(logA, (e) => e.type === "message" && (e.data as RoomMessage).from === idB)).data as RoomMessage;
  assert.deepEqual(fromB.gloss, ["САЛАМ"]);
  assert.equal(fromB.seq, 2);
  assert.throws(() => a.send("   ", { via: "text" }));

  b.setStatus("signing");
  const st = (await waitFor(logA, (e) => e.type === "status")).data as { clientId: string; status: string };
  assert.deepEqual(st, { clientId: idB, status: "signing" });

  // Сервер өчүп калды: экөө тең reconnecting; ошол учурда жөнөтүлгөн билдирүү кезекке турат
  const port = srv.port;
  await srv.close();
  await waitFor(logA, (e) => e.type === "state" && e.data === "reconnecting");
  await waitFor(logB, (e) => e.type === "state" && e.data === "reconnecting");
  const markA = logA.length;
  const markB = logB.length;
  const queued = a.send("Кезекте турган билдирүү", { via: "text" });
  await sleep(300);
  srv = await start({ port });

  // Кезектеги билдирүү келет — же жандуу message окуясы, же кайра туташуудагы welcome тарыхы аркылуу.
  const delivered = (e: Ev) =>
    (e.type === "message" && (e.data as RoomMessage).id === queued.id) ||
    (e.type === "welcome" && (e.data as { history: RoomMessage[] }).history.some((m) => m.id === queued.id));
  await waitFor(logB, delivered, 20_000, markB);
  await waitFor(logA, delivered, 20_000, markA);
  const welcomesB = logB.slice(markB).filter((e) => e.type === "welcome");
  assert.equal(welcomesB.length, 1);
  assert.ok(
    (welcomesB[0].data as { history: RoomMessage[] }).history.every((m) => m.seq > 2),
    "кайра туташканда эски билдирүүлөр кайталанбайт",
  );
  const allB = [
    ...logB.filter((e) => e.type === "message").map((e) => (e.data as RoomMessage).seq),
    ...logB.filter((e) => e.type === "welcome").flatMap((e) => (e.data as { history: RoomMessage[] }).history.map((m) => m.seq)),
  ].sort();
  assert.deepEqual(allB, [1, 2, 3], "ар бир seq бир жолу");
  assert.equal(a.state, "open");
  assert.equal(b.state, "open");
  // Билдирүү бир гана жолу сакталды
  const sum = (await checkRoom(room.code))!;
  assert.equal(sum.messageCount, 3);
  // Кайра туташкандан кийин signer'дин абалы кайра билдирилет (status окуясы же welcome'догу катышуучу)
  await waitFor(
    logA,
    (e) =>
      (e.type === "status" && (e.data as { status: string }).status === "signing") ||
      (e.type === "presence" &&
        (e.data as { clientId: string; status: string }[]).some((p) => p.clientId === idB && p.status === "signing")),
    5000,
    markA,
  );

  // Жок бөлмө: error not_found → closed, кайра туташпайт
  const ghost = new RoomClient({ code: "999999" === room.code ? "999998" : "999999", name: "x", role: "speaker" });
  const logG = record(ghost);
  ghost.connect();
  const err = (await waitFor(logG, (e) => e.type === "error")).data as { code: string };
  assert.equal(err.code, "not_found");
  await waitFor(logG, (e) => e.type === "state" && e.data === "closed");
  await sleep(1500);
  assert.equal(ghost.state, "closed");
  assert.equal(logG.filter((e) => e.type === "state" && e.data === "reconnecting").length, 0);

  // close(): кайра туташпайт, presence'те offline
  b.close();
  assert.equal(b.state, "closed");
  await waitFor(
    logA,
    (e) => e.type === "presence" && (e.data as { clientId: string; online: boolean }[]).some((p) => p.clientId === idB && !p.online),
    5000,
    markA,
  );
  a.close();
  await sleep(100);
});

// ---------------------------------------------------------------------------

test("heartbeat: pong бербеген сокет үзүлөт; hello жибербеген сокет жабылат", async () => {
  const hb = await start({ rooms: { heartbeatMs: 100, helloTimeoutMs: 300 } });
  extraServers.push(hb);
  const created = await fetch(`${hb.url}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "speaker", name: "A" }),
  });
  const c = ((await created.json()) as RoomSummary).code;
  const url = `${hb.url.replace(/^http/, "ws")}/ws`;

  // Тирүү байкоочу (глобалдык WebSocket ping'ке өзү жооп берет)
  const watcher = await Sock.open(url);
  watcher.send({ t: "hello", room: c, clientId: "watch", name: "W", role: "speaker" });
  await watcher.nextOf("welcome");

  // «Өлүк» кардар: ping'ке жооп бербейт
  const dead = new WsClient(url, { autoPong: false });
  await new Promise((r, j) => dead.once("open", r).once("error", j));
  dead.send(JSON.stringify({ t: "hello", room: c, clientId: "dead", name: "D", role: "signer" }));
  dead.send(JSON.stringify({ t: "status", status: "signing" }));
  const pres = await watcher.next((e) => e.t === "presence" && e.participants.some((p) => p.clientId === "dead" && p.online));
  assert.ok(pres);
  assert.equal((await watcher.nextOf("status")).status, "signing");
  const closedAt = await new Promise<number>((r) => dead.once("close", () => r(Date.now())));
  assert.ok(closedAt > 0);
  assert.equal((await watcher.nextOf("status")).status, "idle");
  const off = await watcher.next((e) => e.t === "presence" && e.participants.some((p) => p.clientId === "dead" && !p.online));
  assert.ok(off);
  // Тирүү байкоочу үзүлгөн жок
  await sleep(400);
  assert.equal(watcher.isClosed, false);
  watcher.send({ t: "ping" });
  await watcher.nextOf("pong");

  // hello жок — 4408 менен жабылат
  const silent = await Sock.open(url);
  assert.equal((await silent.closed).code, 4408);
  await watcher.close();
});

test("бир катышуучунун эки өтмөгү: бирөө жабылса status idle, online калат", async () => {
  const r = await createRoomRest("speaker", "Табдар");
  const c = r.body.code;
  const other = (await join(c, "other", "speaker", "O")).s;
  const tab1 = (await join(c, "multi", "signer", "M")).s;
  await other.nextOf("presence");
  const tab2 = (await join(c, "multi", "signer", "M")).s;
  tab1.send({ t: "status", status: "signing" });
  assert.equal((await other.nextOf("status")).status, "signing");
  await tab1.close();
  assert.deepEqual(await other.nextOf("status"), { t: "status", clientId: "multi", status: "idle" });
  await other.expectNone((e) => e.t === "presence", 150);
  await tab2.close();
  const off = await other.nextOf("presence");
  assert.equal(off.participants.find((p) => p.clientId === "multi")?.online, false);
  await other.close();
});

test("HTTPS режими: сертификат, wss, /api/net, бир порттогу http → https", async () => {
  const sec = await start({ https: true });
  extraServers.push(sec);
  assert.equal(sec.https, true);
  assert.ok(existsSync(path.join(dataDir, "cert", "cert.pem")));
  assert.ok(existsSync(path.join(dataDir, "cert", "key.pem")));

  const getJson = (p: string) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      httpsGet(`${sec.url}${p}`, { rejectUnauthorized: false }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(d) }));
      }).on("error", reject);
    });
  const net = await getJson("/api/net");
  assert.equal(net.status, 200);
  const info = net.body as { urls: string[]; https: boolean };
  assert.equal(info.https, true);
  for (const u of info.urls) assert.match(u, new RegExp(`^https://[\\d.]+:${sec.port}$`));

  // Жөнөкөй http ошол эле портто → 308 https'ке
  const redirect = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
    httpRequest(`http://localhost:${sec.port}/room/123456?x=1`, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    })
      .on("error", reject)
      .end();
  });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.location, `https://localhost:${sec.port}/room/123456?x=1`);

  const created = await new Promise<RoomSummary>((resolve, reject) => {
    const req = httpsRequest(
      `${sec.url}/api/rooms`,
      { method: "POST", rejectUnauthorized: false, headers: { "content-type": "application/json" } },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d) as RoomSummary));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ role: "signer", name: "Коопсуз" }));
  });
  const ws = new WsClient(`wss://localhost:${sec.port}/ws`, { rejectUnauthorized: false });
  const welcome = await new Promise<Extract<ServerEvent, { t: "welcome" }>>((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({ t: "hello", room: created.code, clientId: "tls", name: "T", role: "signer" })));
    ws.on("message", (d) => {
      const ev = JSON.parse(String(d)) as ServerEvent;
      if (ev.t === "welcome") resolve(ev);
    });
  });
  assert.equal(welcome.room.code, created.code);
  ws.close();

  // Экинчи жолу ошол эле сертификат колдонулат
  const certBefore = await readFile(path.join(dataDir, "cert", "cert.pem"), "utf8");
  const sec2 = await start({ https: true });
  extraServers.push(sec2);
  assert.equal(await readFile(path.join(dataDir, "cert", "cert.pem"), "utf8"), certBefore);
});
