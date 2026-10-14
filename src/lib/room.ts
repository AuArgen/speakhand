// Сүйлөшүү бөлмөсү: эки түзмөктөгү эки адамды байланыштырат.
//   «speaker» — сүйлөй/уга алган адам (үн → текст; келген жест → текст + үн)
//   «signer»  — жест тилинде сүйлөгөн адам (жест → текст; келген сөз → текст + 3D аватар)
// Каттоо жок: бөлмө ачылат → 6 сандуу код → экинчи адам код (же QR) менен кирет.
// Бөлмө жана анын тарыхы серверде сакталат — ошол эле код менен кийин уланта берсе болот.
//
// ===================== КЕЛИШИМ (бул файлдагы типтер өзгөрбөйт) =====================
//
// REST:
//   POST /api/rooms            { role, name }            → 200 RoomSummary  (жаңы бөлмө)
//   GET  /api/rooms/:code                                → 200 RoomSummary | 404 { error }
//   GET  /api/phrases                                    → 200 { items: PhraseItem[] }   (даяр сүйлөмдөр, тез жооп үчүн)
//   GET  /api/net                                        → 200 NetInfo                    (LAN дареги, QR үчүн)
//
// WebSocket: ws(s)://<host>/ws   — JSON билдирүүлөр (ClientEvent / ServerEvent)
//   1) Туташкандан кийин кардар дароо { t: "hello", ... } жиберет.
//   2) Сервер { t: "welcome", ... } менен жооп берет (тарыхтын акыркы 200 билдирүүсү).
//   3) Үзүлсө — кардар өзү кайра туташат (1s, 2s, 4s … max 15s) жана hello'до lastSeq жиберет;
//      сервер ошондон кийинки билдирүүлөрдү гана кайтарат.
//   4) Ар бир 20 секундда { t: "ping" } → { t: "pong" }.
// =====================================================================================

export type Role = "speaker" | "signer";

/** Билдирүү кантип түзүлдү */
export type MessageVia = "voice" | "sign" | "text" | "quick";

/** Катышуучунун учурдагы абалы (экинчи тарапка «сүйлөп жатат…», «жест көрсөтүп жатат…» деп көрүнөт) */
export type ActivityStatus = "idle" | "speaking" | "signing" | "typing";

export interface Participant {
  /** Түзмөктүн туруктуу ID'си (localStorage) */
  clientId: string;
  name: string;
  role: Role;
  online: boolean;
  status: ActivityStatus;
}

export interface RoomMessage {
  /** Бөлмөдөгү катар номери (1, 2, 3 …), сервер берет */
  seq: number;
  /** Кардар түзгөн уникалдуу ID (кайталанган жөнөтүүнү алдын алат) */
  id: string;
  from: string; // clientId
  name: string;
  role: Role;
  text: string;
  /** Жест глосстору — жест менен түзүлгөн билдирүүдө (via: "sign") же тез жоопто */
  gloss?: string[];
  via: MessageVia;
  /** Сервердин убактысы, мс */
  at: number;
}

export interface RoomSummary {
  code: string;
  createdAt: number;
  participants: Participant[];
  messageCount: number;
}

export interface PhraseItem {
  text: string;
  gloss: string[];
  question: boolean;
  negation: boolean;
}

export interface NetInfo {
  /** Ушул компьютердин LAN даректери, мис. ["https://192.168.1.5:8787"] */
  urls: string[];
  https: boolean;
}

export type ClientEvent =
  | { t: "hello"; room: string; clientId: string; name: string; role: Role; lastSeq?: number }
  | { t: "msg"; id: string; text: string; gloss?: string[]; via: MessageVia }
  | { t: "status"; status: ActivityStatus }
  | { t: "ping" };

export type ServerEvent =
  | { t: "welcome"; room: RoomSummary; you: Participant; history: RoomMessage[] }
  | { t: "msg"; msg: RoomMessage }
  | { t: "presence"; participants: Participant[] }
  | { t: "status"; clientId: string; status: ActivityStatus }
  | { t: "error"; code: "not_found" | "bad_request" | "room_full" | "rate_limited"; message: string }
  | { t: "pong" };

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface RoomClientEvents {
  state: ConnectionState;
  welcome: { room: RoomSummary; you: Participant; history: RoomMessage[] };
  message: RoomMessage;
  presence: Participant[];
  status: { clientId: string; status: ActivityStatus };
  error: { code: string; message: string };
}

// ----- Ишке ашыруу (кол тамгалар өзгөрбөйт) -----
//
// RoomClient окуялары:
//   state    — "connecting" (биринчи туташуу) → "open" (welcome келгенде) → үзүлсө "reconnecting"
//              (1, 2, 4 … 15 с + jitter) → кайра "open". close() же кайтарылгыс ката (not_found,
//              room_full, туура эмес hello) → "closed" жана кайра туташпайт.
//   welcome  — ар бир (кайра) туташууда. Биринчисинде history = акыркы 200 билдирүү; кийинкилеринде
//              history = үзүлүп турганда өткөрүп жиберилгендер гана (seq боюнча кошуп алыңыз).
//              Андан кийин дароо presence да чыгат (room.participants).
//   message  — жаңы билдирүү (өзүңүздүкү да: msg.id === send() кайтарган id → «жөнөтүлдү»).
//              Ар бир seq бир жолу гана чыгат.
//   presence / status / error — серверден келгендей.

const CLIENT_ID_KEY = "suylo.clientId";
const PING_MS = 20_000;
const REPLY_TIMEOUT_MS = 10_000;
const VISIBLE_REPLY_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 15_000;
/** Сервер 20 билдирүү / 10 с кабыл алат — кардар өзү 18 менен чектейт */
const SEND_RATE = 18;
const SEND_WINDOW_MS = 10_000;
const RATE_LIMIT_RETRY_MS = 3_000;
/** Сервер ушул коддор менен жапса — кайра туташуунун пайдасы жок */
const FATAL_CLOSE_CODES = new Set([4400, 4404, 4409]);
const CLOSE_CODE_FATAL = 4400;
const MAX_TEXT = 2000;
const MAX_GLOSS = 60;
const MAX_GLOSS_TOKEN = 64;

let memoryClientId: string | null = null;

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newClientId(): string {
  // crypto.randomUUID коопсуз эмес (http://192.168…) даректе жок — getRandomValues бардык жерде бар.
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    /* төмөндө */
  }
  return randomHex(16);
}

function newMessageId(): string {
  return `${Date.now().toString(36)}-${randomHex(6)}`;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Түзмөктүн туруктуу ID'си (localStorage'та сакталат). */
export function getClientId(): string {
  const ls = getStorage();
  try {
    const saved = ls?.getItem(CLIENT_ID_KEY);
    if (saved && saved.length <= 64) return saved;
  } catch {
    /* жеке режим ж.б. */
  }
  const id = memoryClientId ?? newClientId();
  try {
    if (!ls) throw new Error("no storage");
    ls.setItem(CLIENT_ID_KEY, id);
  } catch {
    memoryClientId = id;
  }
  return id;
}

function apiUrl(p: string): string {
  const href = (globalThis as { location?: { href?: string } }).location?.href;
  return href ? new URL(p, href).toString() : p;
}

async function readError(r: Response): Promise<string> {
  try {
    const data = (await r.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    /* JSON эмес */
  }
  return `Сервер катасы ${r.status}`;
}

function normalizeCode(code: string): string {
  return String(code ?? "").replace(/[\s-]+/g, "");
}

/** Жаңы бөлмө ачат. Ката болсо Error ыргытат (кабары колдонуучуга көрсөтүүгө жарайт). */
export async function createRoom(role: Role, name: string): Promise<RoomSummary> {
  const r = await fetch(apiUrl("/api/rooms"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, name, clientId: getClientId() }),
  });
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as RoomSummary;
}

/** Бөлмө бар-жогун текшерет (жок болсо null). Тармак/сервер катасында Error ыргытат. */
export async function checkRoom(code: string): Promise<RoomSummary | null> {
  const c = normalizeCode(code);
  if (!/^[1-9]\d{5}$/.test(c)) return null;
  const r = await fetch(apiUrl(`/api/rooms/${c}`));
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error(await readError(r));
  return (await r.json()) as RoomSummary;
}

let phrasesCache: Promise<PhraseItem[]> | null = null;

/** Даяр сүйлөмдөр (бир жолу жүктөлүп, эсте калат). Ката болсо — бош тизме. */
export function fetchPhrases(): Promise<PhraseItem[]> {
  phrasesCache ??= (async () => {
    const r = await fetch(apiUrl("/api/phrases"));
    if (!r.ok) throw new Error(await readError(r));
    const data = (await r.json()) as { items?: PhraseItem[] };
    return Array.isArray(data.items) ? data.items : [];
  })().catch((e: unknown) => {
    phrasesCache = null;
    console.warn("Даяр сүйлөмдөр жүктөлгөн жок:", e);
    return [];
  });
  return phrasesCache;
}

/** Ушул компьютердин LAN даректери (QR үчүн). Ката болсо — бош тизме. */
export async function fetchNetInfo(): Promise<NetInfo> {
  const https = (globalThis as { location?: { protocol?: string } }).location?.protocol === "https:";
  try {
    const r = await fetch(apiUrl("/api/net"));
    if (!r.ok) throw new Error(await readError(r));
    const data = (await r.json()) as NetInfo;
    return { urls: Array.isArray(data.urls) ? data.urls : [], https: Boolean(data.https) };
  } catch (e) {
    console.warn("LAN даректери алынган жок:", e);
    return { urls: [], https };
  }
}

interface PendingMsg {
  id: string;
  text: string;
  gloss?: string[];
  via: MessageVia;
  /** Кайсы туташууда жиберилди (0 — азырынча жиберилген жок) */
  sentGen: number;
}

type AnyListener = (data: unknown) => void;

/**
 * Бөлмөгө туташуу. Өзү кайра туташат, жөнөтүлбөгөн билдирүүлөрдү кезекке коёт
 * жана туташкандан кийин жөнөтөт.
 */
export class RoomClient {
  readonly code: string;
  private readonly name: string;
  private readonly role: Role;
  private readonly clientId: string;
  private _state: ConnectionState = "closed";
  private ws: WebSocket | null = null;
  /** Туташуу муун номери: эски сокеттин окуялары этибарга алынбайт */
  private gen = 0;
  private welcomed = false;
  private everWelcomed = false;
  private lastSeq = 0;
  private attempt = 0;
  private wantOpen = false;
  private fatal = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private outbox: PendingMsg[] = [];
  private sendTimes: number[] = [];
  private status: ActivityStatus = "idle";
  private readonly listeners = new Map<keyof RoomClientEvents, Set<AnyListener>>();
  private detachWindow: (() => void) | null = null;

  constructor(opts: { code: string; name: string; role: Role }) {
    this.code = normalizeCode(opts.code);
    this.name = opts.name;
    this.role = opts.role;
    this.clientId = getClientId();
  }

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    if (this.wantOpen && this._state !== "closed") return;
    this.wantOpen = true;
    this.fatal = false;
    this.attempt = 0;
    this.attachWindow();
    this.open("connecting");
  }

  close(): void {
    this.wantOpen = false;
    this.clearTimers();
    this.detachWindow?.();
    this.detachWindow = null;
    this.dropSocket(1000);
    this.setState("closed");
  }

  /** Билдирүү жөнөтөт. Сервер кайтарганга чейин «жөнөтүлүүдө» абалында болот (id менен салыштырылат). */
  send(text: string, opts: { via: MessageVia; gloss?: string[] }): { id: string } {
    const body = String(text ?? "").trim().slice(0, MAX_TEXT);
    const gloss = (opts.gloss ?? [])
      .filter((g): g is string => typeof g === "string")
      .map((g) => g.trim().slice(0, MAX_GLOSS_TOKEN))
      .filter(Boolean)
      .slice(0, MAX_GLOSS);
    if (!body && !gloss.length) throw new Error("Билдирүү бош");
    const id = newMessageId();
    this.outbox.push({ id, text: body, gloss: gloss.length ? gloss : undefined, via: opts.via, sentGen: 0 });
    this.flush();
    return { id };
  }

  setStatus(status: ActivityStatus): void {
    if (status === this.status) return;
    this.status = status;
    if (this.welcomed) this.sendRaw({ t: "status", status });
  }

  on<K extends keyof RoomClientEvents>(event: K, cb: (data: RoomClientEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    const fn = cb as AnyListener;
    set.add(fn);
    return () => {
      this.listeners.get(event)?.delete(fn);
    };
  }

  // ---------------------------------------------------------------------------

  private emit<K extends keyof RoomClientEvents>(event: K, data: RoomClientEvents[K]) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(data);
      } catch (e) {
        console.error(`RoomClient "${event}" угуучусунда ката:`, e);
      }
    }
  }

  private setState(s: ConnectionState) {
    if (s === this._state) return;
    this._state = s;
    this.emit("state", s);
  }

  private wsUrl(): string {
    const loc = (globalThis as { location?: { protocol?: string; host?: string } }).location;
    const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${loc?.host ?? "localhost"}/ws`;
  }

  private open(state: "connecting" | "reconnecting") {
    this.clearTimer("reconnect");
    this.dropSocket(1000);
    this.setState(state);
    const gen = ++this.gen;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.welcomed = false;
    this.armReply(REPLY_TIMEOUT_MS, true); // туташуу/welcome үчүн убакыт
    ws.onopen = () => {
      if (gen !== this.gen) return;
      this.sendRaw({
        t: "hello",
        room: this.code,
        clientId: this.clientId,
        name: this.name,
        role: this.role,
        ...(this.everWelcomed ? { lastSeq: this.lastSeq } : {}),
      });
      this.armReply(REPLY_TIMEOUT_MS, true);
      this.pingTimer = setInterval(() => this.ping(REPLY_TIMEOUT_MS), PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (gen !== this.gen) return;
      this.onServer(ev.data);
    };
    ws.onclose = (ev: CloseEvent) => {
      if (gen !== this.gen) return;
      this.onSocketClosed(ev.code);
    };
    ws.onerror = () => {
      /* артынан close келет */
    };
  }

  /** Учурдагы сокетти таштайт (анын окуялары мындан ары этибарга алынбайт). */
  private dropSocket(code: number) {
    const ws = this.ws;
    this.ws = null;
    this.welcomed = false;
    this.gen++;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearTimer("reply");
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(code);
    } catch {
      /* эч нерсе */
    }
  }

  private onSocketClosed(code: number) {
    this.dropSocket(1000);
    if (!this.wantOpen) return this.setState("closed");
    if (this.fatal || FATAL_CLOSE_CODES.has(code)) {
      this.wantOpen = false;
      this.clearTimers();
      this.detachWindow?.();
      this.detachWindow = null;
      return this.setState("closed");
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.dropSocket(1000);
    if (!this.wantOpen) return;
    this.setState("reconnecting");
    this.clearTimer("reconnect");
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.attempt, 10));
    const delay = Math.min(MAX_BACKOFF_MS, Math.round(base * (0.8 + Math.random() * 0.4)));
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantOpen) this.open("reconnecting");
    }, delay);
  }

  /** Жооп күтүү: убагында эч нерсе келбесе — туташуу өлүк, кайра туташабыз. */
  private armReply(ms: number, reset = false) {
    if (this.replyTimer && !reset) return;
    this.clearTimer("reply");
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.wantOpen) this.scheduleReconnect();
    }, ms);
  }

  private ping(timeoutMs: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendRaw({ t: "ping" });
    this.armReply(timeoutMs);
  }

  /** online / өтмөк көрүнүп калды: күтпөй дароо туташабыз же туташуу тирүүбү текшеребиз. */
  private nudge = () => {
    if (!this.wantOpen) return;
    if (this._state === "reconnecting" && this.reconnectTimer) this.open("reconnecting");
    else if (this._state === "open") this.ping(VISIBLE_REPLY_TIMEOUT_MS);
  };

  private attachWindow() {
    if (this.detachWindow || typeof window === "undefined" || typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") this.nudge();
    };
    window.addEventListener("online", this.nudge);
    document.addEventListener("visibilitychange", onVisible);
    this.detachWindow = () => {
      window.removeEventListener("online", this.nudge);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  private clearTimer(which: "reconnect" | "reply" | "flush") {
    const key = `${which}Timer` as const;
    const t = this[key];
    if (t) clearTimeout(t);
    this[key] = null;
  }

  private clearTimers() {
    this.clearTimer("reconnect");
    this.clearTimer("reply");
    this.clearTimer("flush");
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private sendRaw(ev: ClientEvent) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(ev));
  }

  private ack(m: RoomMessage) {
    if (m.from !== this.clientId || !this.outbox.length) return;
    const i = this.outbox.findIndex((p) => p.id === m.id);
    if (i >= 0) this.outbox.splice(i, 1);
  }

  /** Кезектеги билдирүүлөрдү жөнөтөт (сервердин чегинен ашпай). */
  private flush() {
    this.clearTimer("flush");
    if (!this.welcomed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    this.sendTimes = this.sendTimes.filter((t) => now - t < SEND_WINDOW_MS);
    for (const p of this.outbox) {
      if (p.sentGen === this.gen) continue;
      if (this.sendTimes.length >= SEND_RATE) {
        const wait = Math.max(50, SEND_WINDOW_MS - (now - this.sendTimes[0]) + 50);
        this.flushTimer = setTimeout(() => this.flush(), wait);
        return;
      }
      this.sendRaw({ t: "msg", id: p.id, text: p.text, ...(p.gloss ? { gloss: p.gloss } : {}), via: p.via });
      p.sentGen = this.gen;
      this.sendTimes.push(now);
    }
  }

  private onServer(raw: unknown) {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(typeof raw === "string" ? raw : String(raw)) as ServerEvent;
    } catch {
      return;
    }
    if (!ev || typeof ev !== "object") return;
    this.clearTimer("reply"); // бир нерсе келди — туташуу тирүү
    switch (ev.t) {
      case "welcome": {
        const history = Array.isArray(ev.history) ? ev.history : [];
        for (const m of history) this.ack(m);
        let last = typeof ev.room?.messageCount === "number" ? ev.room.messageCount : 0;
        for (const m of history) if (m.seq > last) last = m.seq;
        this.lastSeq = last;
        this.welcomed = true;
        this.everWelcomed = true;
        this.attempt = 0;
        this.setState("open");
        this.emit("welcome", { room: ev.room, you: ev.you, history });
        if (Array.isArray(ev.room?.participants)) this.emit("presence", ev.room.participants);
        // Сервер үзүлгөндө абалды idle кылат — учурдагысын кайра билдиребиз.
        if (this.status !== "idle") this.sendRaw({ t: "status", status: this.status });
        this.flush();
        return;
      }
      case "msg": {
        const m = ev.msg;
        if (!m || typeof m.seq !== "number") return;
        this.ack(m);
        if (m.seq > this.lastSeq) {
          this.lastSeq = m.seq;
          this.emit("message", m);
        }
        return;
      }
      case "presence":
        if (Array.isArray(ev.participants)) this.emit("presence", ev.participants);
        return;
      case "status":
        this.emit("status", { clientId: ev.clientId, status: ev.status });
        return;
      case "error":
        if (ev.code === "rate_limited" && this.outbox.length) {
          // Кабыл алынбагандары кайра жөнөтүлөт (сервер id боюнча кайталоону өзү алып салат).
          for (const p of this.outbox) p.sentGen = 0;
          this.clearTimer("flush");
          this.flushTimer = setTimeout(() => this.flush(), RATE_LIMIT_RETRY_MS);
        }
        this.emit("error", { code: ev.code, message: ev.message });
        if (!this.welcomed && ev.code !== "rate_limited") {
          // hello кабыл алынган жок (not_found / room_full / bad_request) — кайра туташпайбыз.
          this.fatal = true;
          this.onSocketClosed(CLOSE_CODE_FATAL);
        }
        return;
      case "pong":
        return;
    }
  }
}
