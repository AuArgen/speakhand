// Сүйлөшүү бөлмөлөрү: эс тутумдагы сактагыч + дискке жазуу (server/data/rooms/<code>.json)
// жана WebSocket хабы (/ws). Протокол — src/lib/room.ts ичиндеги келишим.
import { randomInt } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { clientIp } from "./net.ts";
import type {
  ActivityStatus,
  MessageVia,
  Participant,
  Role,
  RoomMessage,
  RoomSummary,
  ServerEvent,
} from "../src/lib/room.ts";

export const ROOM_LIMITS = {
  maxParticipants: 8,
  maxText: 2000,
  maxGloss: 60,
  maxGlossToken: 64,
  maxName: 40,
  maxId: 64,
  /** Бөлмөдө сакталган билдирүүлөрдүн эң көп саны */
  historyCap: 1000,
  /** welcome'до (lastSeq жок болсо) жиберилген акыркы билдирүүлөр */
  welcomeHistory: 200,
  /** Бир катышуучудан: msgRate билдирүү / rateWindowMs */
  msgRate: 20,
  rateWindowMs: 10_000,
  /** Бир сокеттен: statusRate status / rateWindowMs */
  statusRate: 60,
  /** Ушунча убакыт аракетсиз бөлмө өчүрүлөт */
  expireMs: 30 * 24 * 60 * 60 * 1000,
} as const;

const ROLES: readonly Role[] = ["speaker", "signer"];
const VIAS: readonly MessageVia[] = ["voice", "sign", "text", "quick"];
const STATUSES: readonly ActivityStatus[] = ["idle", "speaking", "signing", "typing"];
const CODE_RE = /^[1-9]\d{5}$/;
const FILE_RE = /^([1-9]\d{5})\.json$/;
const DEFAULT_NAME = "Конок";

export const isRoomCode = (code: unknown): code is string => typeof code === "string" && CODE_RE.test(code);
export const isRole = (r: unknown): r is Role => ROLES.includes(r as Role);

/** Атты тазалайт: боштуктар бириктирилет, 40 белгиге чейин, бош болсо «Конок». */
export function cleanName(name: unknown): string {
  const s = typeof name === "string" ? name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim() : "";
  return s.slice(0, ROOM_LIMITS.maxName).trim() || DEFAULT_NAME;
}

// ============================== Сактагыч ==============================

interface StoredParticipant {
  clientId: string;
  name: string;
  role: Role;
  joinedAt: number;
  lastSeen: number;
}

interface StoredRoom {
  v: 1;
  code: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  participants: StoredParticipant[];
  messages: RoomMessage[];
}

/** WebSocket туташуусунун абалы. */
interface Conn {
  ws: WebSocket;
  ip: string;
  alive: boolean;
  room: Room | null;
  clientId: string | null;
  helloTimer: NodeJS.Timeout | null;
  statusTimes: number[];
  badCount: number;
}

export class Room {
  readonly code: string;
  readonly createdAt: number;
  updatedAt: number;
  lastSeq: number;
  readonly participants = new Map<string, StoredParticipant>();
  messages: RoomMessage[];
  readonly byId = new Map<string, RoomMessage>();

  // --- жандуу абал (дискке жазылбайт) ---
  readonly conns = new Map<string, Set<Conn>>();
  readonly status = new Map<string, { status: ActivityStatus; conn: Conn }>();
  readonly msgTimes = new Map<string, number[]>();

  // --- дискке жазуу ---
  dirty = false;
  saveTimer: NodeJS.Timeout | null = null;
  writing: Promise<void> = Promise.resolve();
  lastAccess: number;

  constructor(data: StoredRoom, now: number) {
    this.code = data.code;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
    this.lastSeq = data.lastSeq;
    this.messages = data.messages;
    for (const p of data.participants) this.participants.set(p.clientId, p);
    for (const m of data.messages) this.byId.set(m.id, m);
    this.lastAccess = now;
  }

  isOnline(clientId: string): boolean {
    return (this.conns.get(clientId)?.size ?? 0) > 0;
  }

  get hasConnections(): boolean {
    for (const set of this.conns.values()) if (set.size) return true;
    return false;
  }

  view(p: StoredParticipant): Participant {
    const online = this.isOnline(p.clientId);
    return {
      clientId: p.clientId,
      name: p.name,
      role: p.role,
      online,
      status: online ? (this.status.get(p.clientId)?.status ?? "idle") : "idle",
    };
  }

  participantList(): Participant[] {
    return [...this.participants.values()].map((p) => this.view(p));
  }

  /** messageCount — бөлмөдө жалпы жөнөтүлгөн билдирүүлөр саны (= акыркы seq). */
  summary(): RoomSummary {
    return { code: this.code, createdAt: this.createdAt, participants: this.participantList(), messageCount: this.lastSeq };
  }

  /** lastSeq'тен кийинки билдирүүлөр (seq'тер үзгүлтүксүз: эскилери башынан гана өчөт). */
  historyAfter(lastSeq: number | undefined): RoomMessage[] {
    if (lastSeq === undefined || lastSeq > this.lastSeq) return this.messages.slice(-ROOM_LIMITS.welcomeHistory);
    const missed = this.lastSeq - lastSeq;
    return missed <= 0 ? [] : this.messages.slice(Math.max(0, this.messages.length - missed));
  }

  toJSON(): StoredRoom {
    return {
      v: 1,
      code: this.code,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastSeq: this.lastSeq,
      participants: [...this.participants.values()],
      messages: this.messages,
    };
  }
}

export interface RoomStoreOptions {
  /** Бөлмө файлдары жазылуучу папка */
  dir: string;
  /** Дискке жазууну кечиктирүү (мс) — бир нече өзгөрүү бир жазууга топтолот */
  saveDelayMs?: number;
  expireMs?: number;
  /** Эскирген бөлмөлөрдү тазалоо аралыгы (мс) */
  sweepIntervalMs?: number;
  /** Эс тутумдан чыгаруу: туташуусу жок бөлмө ушунча мс колдонулбаса */
  unloadAfterMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isStoredRoom(x: unknown, code: string): x is StoredRoom {
  const r = x as StoredRoom;
  return (
    !!r &&
    typeof r === "object" &&
    r.code === code &&
    typeof r.createdAt === "number" &&
    typeof r.updatedAt === "number" &&
    typeof r.lastSeq === "number" &&
    Array.isArray(r.participants) &&
    Array.isArray(r.messages)
  );
}

export class RoomStore {
  readonly dir: string;
  private readonly rooms = new Map<string, Room>();
  private readonly saveDelayMs: number;
  private readonly expireMs: number;
  private readonly sweepIntervalMs: number;
  private readonly unloadAfterMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: RoomStoreOptions) {
    this.dir = opts.dir;
    this.saveDelayMs = opts.saveDelayMs ?? 250;
    this.expireMs = opts.expireMs ?? ROOM_LIMITS.expireMs;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 6 * 60 * 60 * 1000;
    this.unloadAfterMs = opts.unloadAfterMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep().catch((e) => this.log(`бөлмөлөрдү тазалоо: ${e}`)), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private file(code: string) {
    return path.join(this.dir, `${code}.json`);
  }

  /** Жаңы бөлмө: 6 сандуу, 0 менен башталбаган, кайталанбаган код. */
  create(role: Role, name: string, clientId?: string): Room {
    let code = "";
    for (let i = 0; i < 100; i++) {
      const c = String(randomInt(100_000, 1_000_000));
      if (!this.rooms.has(c) && !existsSync(this.file(c))) {
        code = c;
        break;
      }
    }
    if (!code) throw new Error("Бош код табылган жок");
    const now = this.now();
    const room = new Room({ v: 1, code, createdAt: now, updatedAt: now, lastSeq: 0, participants: [], messages: [] }, now);
    if (clientId) room.participants.set(clientId, { clientId, name: cleanName(name), role, joinedAt: now, lastSeen: now });
    this.rooms.set(code, room);
    this.markDirty(room, true);
    return room;
  }

  /** Бөлмөнү эс тутумдан же дисктен (керек болгондо гана) алат. */
  get(code: string): Room | null {
    if (!isRoomCode(code)) return null;
    const cached = this.rooms.get(code);
    if (cached) {
      cached.lastAccess = this.now();
      return cached;
    }
    const file = this.file(code);
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    try {
      const data: unknown = JSON.parse(raw);
      if (!isStoredRoom(data, code)) throw new Error("түзүлүшү туура эмес");
      const room = new Room(data, this.now());
      this.rooms.set(code, room);
      return room;
    } catch (e) {
      this.log(`Бөлмө ${code} окулбай калды (${(e as Error).message}) — .corrupt деп кайра аталды`);
      try {
        renameSync(file, `${file}.${Date.now()}.corrupt`);
      } catch {
        /* эч нерсе */
      }
      return null;
    }
  }

  /** Өзгөрүүнү белгилейт; дискке бир аздан кийин (топтоп) жазылат. */
  markDirty(room: Room, activity = false) {
    if (activity) room.updatedAt = this.now();
    room.dirty = true;
    if (room.saveTimer) return;
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      this.writeRoom(room);
    }, this.saveDelayMs);
  }

  private writeRoom(room: Room): Promise<void> {
    if (!room.dirty) return room.writing;
    room.dirty = false;
    const json = JSON.stringify(room.toJSON());
    room.writing = room.writing.then(() =>
      this.atomicWrite(this.file(room.code), json).catch((e) => {
        this.log(`Бөлмө ${room.code} жазылбай калды: ${(e as Error).message}`);
        this.markDirty(room);
      }),
    );
    return room.writing;
  }

  /** Убактылуу файлга жазып, анан атын өзгөртөт (Windows'та бөгөттөлсө кайталайт). */
  private async atomicWrite(file: string, data: string) {
    const tmp = `${file}.${process.pid}.${randomInt(1e9)}.tmp`;
    await writeFile(tmp, data, "utf8");
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt < 8 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
          await sleep(25 * (attempt + 1));
          continue;
        }
        await unlink(tmp).catch(() => {});
        throw e;
      }
    }
  }

  /** Бардык өзгөрүүлөрдү дароо дискке жазат. */
  async flush(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const room of this.rooms.values()) {
      if (room.saveTimer) {
        clearTimeout(room.saveTimer);
        room.saveTimer = null;
      }
      pending.push(this.writeRoom(room));
    }
    await Promise.all(pending);
  }

  /** 30 күн аракетсиз бөлмөлөрдү өчүрөт, эс тутумдан колдонулбагандарын чыгарат. */
  async sweep(): Promise<string[]> {
    const now = this.now();
    const deleted: string[] = [];
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return deleted;
    }
    for (const f of files) {
      const full = path.join(this.dir, f);
      if (f.endsWith(".tmp")) {
        // Үзүлүп калган жазуунун калдыгы
        const st = await stat(full).catch(() => null);
        if (st && now - st.mtimeMs > 60 * 60 * 1000) await unlink(full).catch(() => {});
        continue;
      }
      const m = FILE_RE.exec(f);
      if (!m) continue;
      const code = m[1];
      const loaded = this.rooms.get(code);
      let last: number;
      if (loaded) {
        if (loaded.hasConnections) continue;
        last = loaded.updatedAt;
      } else {
        const st = await stat(full).catch(() => null);
        if (!st) continue;
        last = st.mtimeMs;
      }
      if (now - last <= this.expireMs) continue;
      const again = this.rooms.get(code);
      if (again && (again.hasConnections || now - again.updatedAt <= this.expireMs)) continue;
      if (again?.saveTimer) clearTimeout(again.saveTimer);
      this.rooms.delete(code);
      await unlink(full).catch(() => {});
      deleted.push(code);
    }
    for (const [code, room] of this.rooms) {
      if (!room.hasConnections && !room.dirty && !room.saveTimer && now - room.lastAccess > this.unloadAfterMs) {
        this.rooms.delete(code);
      }
    }
    if (deleted.length) this.log(`Эскирген бөлмөлөр өчүрүлдү: ${deleted.join(", ")}`);
    return deleted;
  }

  /** Эс тутумдагы бөлмөлөр (тест жана мониторинг үчүн). */
  loadedCount() {
    return this.rooms.size;
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.flush();
  }
}

// ============================== WebSocket хабы ==============================

export interface RoomHubOptions {
  /** ping/pong аралыгы (мс); жооп бербеген сокет үзүлөт */
  heartbeatMs?: number;
  /** hello келбесе ушунча мс кийин жабылат */
  helloTimeoutMs?: number;
  msgRate?: number;
  statusRate?: number;
  rateWindowMs?: number;
  log?: (msg: string) => void;
}

type ErrorCode = Extract<ServerEvent, { t: "error" }>["code"];

/** Кардарга жабылуу коддору: булар келсе кардар кайра туташпайт. */
export const CLOSE_CODES = { badHello: 4400, notFound: 4404, roomFull: 4409, helloTimeout: 4408 } as const;

const MAX_BAD = 50;

export class RoomHub {
  readonly wss: WebSocketServer;
  private readonly conns = new Set<Conn>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly helloTimeoutMs: number;
  private readonly msgRate: number;
  private readonly statusRate: number;
  private readonly rateWindowMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly store: RoomStore,
    opts: RoomHubOptions = {},
  ) {
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    this.msgRate = opts.msgRate ?? ROOM_LIMITS.msgRate;
    this.statusRate = opts.statusRate ?? ROOM_LIMITS.statusRate;
    this.rateWindowMs = opts.rateWindowMs ?? ROOM_LIMITS.rateWindowMs;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    this.wss.on("error", (e) => this.log(`ws сервер катасы: ${e.message}`));
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.heartbeat = setInterval(() => this.beat(), opts.heartbeatMs ?? 20_000);
    this.heartbeat.unref();
  }

  /** HTTP upgrade: /ws болсо кабыл алат жана true кайтарат. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://x").pathname;
    } catch {
      return false;
    }
    if (pathname !== "/ws") return false;
    socket.on("error", () => {});
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
    return true;
  }

  get connectionCount() {
    return this.conns.size;
  }

  private beat() {
    for (const c of this.conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
        c.ws.terminate();
      }
    }
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const conn: Conn = {
      ws,
      ip: clientIp(req),
      alive: true,
      room: null,
      clientId: null,
      helloTimer: null,
      statusTimes: [],
      badCount: 0,
    };
    this.conns.add(conn);
    conn.helloTimer = setTimeout(() => {
      if (!conn.room) ws.close(CLOSE_CODES.helloTimeout, "hello timeout");
    }, this.helloTimeoutMs);
    ws.on("pong", () => (conn.alive = true));
    ws.on("error", () => {});
    ws.on("close", () => this.onClose(conn));
    ws.on("message", (data: RawData, isBinary: boolean) => {
      try {
        this.onMessage(conn, data, isBinary);
      } catch (e) {
        this.log(`ws билдирүүсүн иштетүүдө ката: ${(e as Error).stack ?? e}`);
        this.error(conn, "bad_request", "Сервер катасы");
      }
    });
  }

  private send(conn: Conn, ev: ServerEvent) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(ev));
  }

  private error(conn: Conn, code: ErrorCode, message: string) {
    this.send(conn, { t: "error", code, message });
    if (code === "bad_request" && ++conn.badCount > MAX_BAD) conn.ws.close(1008, "too many bad requests");
  }

  /** Бөлмөдөгү сокеттерге жиберет (filter false кайтарганды өткөрүп жиберет). */
  private broadcast(room: Room, ev: ServerEvent, filter?: (c: Conn) => boolean) {
    const data = JSON.stringify(ev);
    for (const set of room.conns.values()) {
      for (const c of set) {
        if (filter && !filter(c)) continue;
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
      }
    }
  }

  private onMessage(conn: Conn, data: RawData, isBinary: boolean) {
    conn.alive = true;
    if (isBinary) return this.error(conn, "bad_request", "Текст (JSON) билдирүү күтүлөт");
    let ev: unknown;
    try {
      ev = JSON.parse(rawToString(data));
    } catch {
      return this.error(conn, "bad_request", "JSON туура эмес");
    }
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return this.error(conn, "bad_request", "Объект күтүлөт");
    const e = ev as Record<string, unknown>;
    switch (e.t) {
      case "ping":
        return this.send(conn, { t: "pong" });
      case "hello":
        return this.onHello(conn, e);
      case "msg":
        return this.onMsg(conn, e);
      case "status":
        return this.onStatus(conn, e);
      default:
        return this.error(conn, "bad_request", "Белгисиз билдирүү түрү");
    }
  }

  private rejectHello(conn: Conn, code: ErrorCode, message: string, closeCode: number) {
    this.send(conn, { t: "error", code, message });
    conn.ws.close(closeCode, code);
  }

  private onHello(conn: Conn, e: Record<string, unknown>) {
    if (conn.room) return this.error(conn, "bad_request", "Бөлмөгө мурунтан эле кошулгансыз");
    const { room: code, clientId, name, role, lastSeq } = e;
    if (typeof code !== "string" || !CODE_RE.test(code)) {
      return this.rejectHello(conn, "bad_request", "Бөлмөнүн коду 6 сандан турат", CLOSE_CODES.badHello);
    }
    if (typeof clientId !== "string" || !clientId || clientId.length > ROOM_LIMITS.maxId) {
      return this.rejectHello(conn, "bad_request", "clientId туура эмес", CLOSE_CODES.badHello);
    }
    if (!isRole(role)) return this.rejectHello(conn, "bad_request", "role: speaker же signer", CLOSE_CODES.badHello);
    if (lastSeq !== undefined && !(Number.isSafeInteger(lastSeq) && (lastSeq as number) >= 0)) {
      return this.rejectHello(conn, "bad_request", "lastSeq туура эмес", CLOSE_CODES.badHello);
    }
    if (name !== undefined && typeof name !== "string") {
      return this.rejectHello(conn, "bad_request", "name туура эмес", CLOSE_CODES.badHello);
    }
    const room = this.store.get(code);
    if (!room) return this.rejectHello(conn, "not_found", "Мындай бөлмө жок", CLOSE_CODES.notFound);

    const now = this.store.now();
    const cleanedName = cleanName(name);
    let p = room.participants.get(clientId);
    let changed = false;
    if (!p) {
      if (room.participants.size >= ROOM_LIMITS.maxParticipants) {
        // Орун бошотуу: эң эрте чыгып кеткен оффлайн катышуучу
        let oldest: StoredParticipant | null = null;
        for (const q of room.participants.values()) {
          if (!room.isOnline(q.clientId) && (!oldest || q.lastSeen < oldest.lastSeen)) oldest = q;
        }
        if (!oldest) {
          return this.rejectHello(
            conn,
            "room_full",
            `Бөлмө толук (${ROOM_LIMITS.maxParticipants} катышуучуга чейин)`,
            CLOSE_CODES.roomFull,
          );
        }
        room.participants.delete(oldest.clientId);
        room.msgTimes.delete(oldest.clientId);
      }
      p = { clientId, name: cleanedName, role, joinedAt: now, lastSeen: now };
      room.participants.set(clientId, p);
      changed = true;
    } else if (p.name !== cleanedName || p.role !== role) {
      p.name = cleanedName;
      p.role = role;
      changed = true;
    }
    p.lastSeen = now;

    const wasOnline = room.isOnline(clientId);
    let set = room.conns.get(clientId);
    if (!set) room.conns.set(clientId, (set = new Set()));
    set.add(conn);
    conn.room = room;
    conn.clientId = clientId;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    room.lastAccess = now;
    this.store.markDirty(room, true);

    this.send(conn, {
      t: "welcome",
      room: room.summary(),
      you: room.view(p),
      history: room.historyAfter(lastSeq as number | undefined),
    });
    if (changed || !wasOnline) {
      this.broadcast(room, { t: "presence", participants: room.participantList() }, (c) => c !== conn);
    }
  }

  private onMsg(conn: Conn, e: Record<string, unknown>) {
    const room = conn.room;
    const clientId = conn.clientId;
    if (!room || !clientId) return this.error(conn, "bad_request", "Алгач hello жибериңиз");
    const { id, text, gloss, via } = e;
    if (typeof id !== "string" || !id || id.length > ROOM_LIMITS.maxId) return this.error(conn, "bad_request", "id туура эмес");
    if (typeof text !== "string") return this.error(conn, "bad_request", "text туура эмес");
    if (!VIAS.includes(via as MessageVia)) return this.error(conn, "bad_request", "via туура эмес");
    const body = text.trim();
    if (body.length > ROOM_LIMITS.maxText) {
      return this.error(conn, "bad_request", `Текст өтө узун (${ROOM_LIMITS.maxText} белгиге чейин)`);
    }
    let tokens: string[] | undefined;
    if (gloss !== undefined && gloss !== null) {
      if (!Array.isArray(gloss)) return this.error(conn, "bad_request", "gloss тизме болушу керек");
      if (gloss.length > ROOM_LIMITS.maxGloss) {
        return this.error(conn, "bad_request", `Глосс өтө узун (${ROOM_LIMITS.maxGloss} сөзгө чейин)`);
      }
      tokens = [];
      for (const g of gloss) {
        if (typeof g !== "string" || !g.trim() || g.trim().length > ROOM_LIMITS.maxGlossToken) {
          return this.error(conn, "bad_request", "Глосс сөзү туура эмес");
        }
        tokens.push(g.trim());
      }
      if (!tokens.length) tokens = undefined;
    }
    if (!body && !tokens) return this.error(conn, "bad_request", "Билдирүү бош");

    // Кайталанган жөнөтүү: жаңы билдирүү түзүлбөйт, жөнөтүүчүгө мурункусу кайра жиберилет.
    const existing = room.byId.get(id);
    if (existing) {
      if (existing.from !== clientId) return this.error(conn, "bad_request", "Бул id башка катышуучуга таандык");
      return this.send(conn, { t: "msg", msg: existing });
    }

    const now = this.store.now();
    const times = (room.msgTimes.get(clientId) ?? []).filter((t) => now - t < this.rateWindowMs);
    if (times.length >= this.msgRate) {
      room.msgTimes.set(clientId, times);
      return this.error(conn, "rate_limited", "Өтө тез жөнөтүп жатасыз — бир аз күтүңүз");
    }
    times.push(now);
    room.msgTimes.set(clientId, times);

    const p = room.participants.get(clientId);
    const msg: RoomMessage = {
      seq: room.lastSeq + 1,
      id,
      from: clientId,
      name: p?.name ?? DEFAULT_NAME,
      role: p?.role ?? "speaker",
      text: body,
      ...(tokens ? { gloss: tokens } : {}),
      via: via as MessageVia,
      at: now,
    };
    room.lastSeq = msg.seq;
    room.messages.push(msg);
    room.byId.set(id, msg);
    if (room.messages.length > ROOM_LIMITS.historyCap) {
      for (const old of room.messages.splice(0, room.messages.length - ROOM_LIMITS.historyCap)) room.byId.delete(old.id);
    }
    if (p) p.lastSeen = now;
    room.lastAccess = now;
    this.store.markDirty(room, true);
    this.broadcast(room, { t: "msg", msg });
  }

  private onStatus(conn: Conn, e: Record<string, unknown>) {
    const room = conn.room;
    const clientId = conn.clientId;
    if (!room || !clientId) return this.error(conn, "bad_request", "Алгач hello жибериңиз");
    const status = e.status as ActivityStatus;
    if (!STATUSES.includes(status)) return this.error(conn, "bad_request", "status туура эмес");
    const now = this.store.now();
    conn.statusTimes = conn.statusTimes.filter((t) => now - t < this.rateWindowMs);
    if (conn.statusTimes.length >= this.statusRate) return this.error(conn, "rate_limited", "Өтө көп status");
    conn.statusTimes.push(now);
    const prev = room.status.get(clientId);
    room.status.set(clientId, { status, conn });
    if (prev?.status === status) return;
    this.broadcast(room, { t: "status", clientId, status }, (c) => c.clientId !== clientId);
  }

  private onClose(conn: Conn) {
    this.conns.delete(conn);
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    const room = conn.room;
    const clientId = conn.clientId;
    if (!room || !clientId) return;
    conn.room = null;
    const set = room.conns.get(clientId);
    set?.delete(conn);
    const stillOnline = (set?.size ?? 0) > 0;
    if (!stillOnline) room.conns.delete(clientId);
    room.lastAccess = this.store.now();

    // Ушул сокет койгон status'ту (же катышуучу толук чыкса — баарын) idle'га кайтарабыз.
    const st = room.status.get(clientId);
    if (st && (!stillOnline || st.conn === conn)) {
      room.status.delete(clientId);
      if (st.status !== "idle") this.broadcast(room, { t: "status", clientId, status: "idle" }, (c) => c.clientId !== clientId);
    }
    if (!stillOnline) {
      const p = room.participants.get(clientId);
      if (p) {
        p.lastSeen = this.store.now();
        this.store.markDirty(room);
      }
      this.broadcast(room, { t: "presence", participants: room.participantList() });
    }
  }

  /** Бардык туташууларды жабат. */
  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const c of this.conns) {
      try {
        c.ws.close(1001, "server shutdown");
      } catch {
        /* эч нерсе */
      }
    }
    await sleep(20);
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
