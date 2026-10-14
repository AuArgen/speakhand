// RoomClient → React абалы. Билдирүүлөр (жөнөтүлүүдө / жөнөтүлдү), катышуучулар, байланыш абалы.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RoomClient,
  isThisDevice,
  participantId,
  type ActivityStatus,
  type ConnectionState,
  type MessageVia,
  type Participant,
  type Role,
  type RoomMessage,
  type RoomSummary,
} from "../lib/room";

export interface TimelineItem {
  id: string;
  /** сервер берген катар номери; жөнөтүлүүдө болсо жок */
  seq?: number;
  from: string;
  name: string;
  role: Role;
  text: string;
  gloss?: string[];
  via: MessageVia;
  at: number;
  pending: boolean;
  mine: boolean;
}

export interface RoomError {
  code: string;
  message: string;
}

export interface RoomHook {
  state: ConnectionState;
  /** welcome келгенге чейин null */
  room: RoomSummary | null;
  you: Participant | null;
  participants: Participant[];
  partner: Participant | null;
  partnerStatus: ActivityStatus;
  messages: TimelineItem[];
  error: RoomError | null;
  /** welcome келгенден кийин жаңы келген экинчи тараптын билдирүүсү (тарых эмес) */
  incoming: RoomMessage | null;
  send(text: string, opts: { via: MessageVia; gloss?: string[] }): void;
  setStatus(status: ActivityStatus): void;
  reconnect(): void;
}

export interface RoomOptions {
  code: string;
  role: Role;
  name: string;
}

function toItem(m: RoomMessage, me: string): TimelineItem {
  return { ...m, pending: false, mine: m.from === me };
}

function sortItems(items: TimelineItem[]): TimelineItem[] {
  return items.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    if (a.seq !== undefined) return -1;
    if (b.seq !== undefined) return 1;
    return a.at - b.at;
  });
}

/** Келгендерди учурдагылар менен бириктирет: id боюнча, «жөнөтүлүүдө» абалын жабат. */
function merge(prev: TimelineItem[], incoming: RoomMessage[], me: string): TimelineItem[] {
  if (!incoming.length) return prev;
  const map = new Map(prev.map((p) => [p.id, p]));
  for (const m of incoming) map.set(m.id, toItem(m, me));
  return sortItems([...map.values()]);
}

export function useRoom(opts: RoomOptions | null): RoomHook {
  const role = opts?.role ?? null;
  const me = useMemo(() => (role ? participantId(role) : ""), [role]);
  const [gen, setGen] = useState(0);
  const [state, setState] = useState<ConnectionState>("connecting");
  const [room, setRoom] = useState<RoomSummary | null>(null);
  const [you, setYou] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [messages, setMessages] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<RoomError | null>(null);
  const [incoming, setIncoming] = useState<RoomMessage | null>(null);
  const client = useRef<RoomClient | null>(null);
  const lastStatus = useRef<ActivityStatus>("idle");
  const welcomed = useRef(false);

  const code = opts?.code ?? null;
  const name = opts?.name ?? "";

  useEffect(() => {
    if (!code || !role) return;
    const c = new RoomClient({ code, name, role });
    client.current = c;
    welcomed.current = false;
    setState("connecting");
    setError(null);
    const offs = [
      c.on("state", setState),
      c.on("welcome", ({ room: r, you: y, history }) => {
        welcomed.current = true;
        setRoom(r);
        setYou(y);
        setParticipants(r.participants);
        setMessages((prev) => merge(prev, history, me));
        setError(null);
      }),
      c.on("message", (m) => {
        setMessages((prev) => merge(prev, [m], me));
        if (m.from !== me && welcomed.current) setIncoming(m);
      }),
      c.on("presence", (list) => {
        setParticipants(list);
        setRoom((r) => (r ? { ...r, participants: list } : r));
      }),
      c.on("status", ({ clientId, status }) => {
        setParticipants((list) => list.map((p) => (p.clientId === clientId ? { ...p, status } : p)));
      }),
      c.on("error", (e) => setError(e)),
    ];
    // Бир тик кечиктирип туташабыз: React StrictMode эки жолу монтаждаганда бош сокет ачылбайт
    const t = window.setTimeout(() => c.connect(), 0);
    return () => {
      window.clearTimeout(t);
      offs.forEach((off) => off());
      c.close();
      if (client.current === c) client.current = null;
    };
  }, [code, role, name, me, gen]);

  // Бөлмө алмашса — тарых тазаланат
  useEffect(() => {
    setMessages([]);
    setRoom(null);
    setYou(null);
    setParticipants([]);
    setIncoming(null);
  }, [code]);

  const send = useCallback<RoomHook["send"]>(
    (text, o) => {
      const c = client.current;
      const t = text.trim();
      if (!c || !t || !role) return;
      const { id } = c.send(t, o);
      const item: TimelineItem = {
        id,
        from: me,
        name,
        role,
        text: t,
        gloss: o.gloss,
        via: o.via,
        at: Date.now(),
        pending: true,
        mine: true,
      };
      setMessages((prev) => (prev.some((p) => p.id === id) ? prev : sortItems([...prev, item])));
      if (lastStatus.current !== "idle") {
        lastStatus.current = "idle";
        c.setStatus("idle");
      }
    },
    [me, name, role],
  );

  const setStatus = useCallback<RoomHook["setStatus"]>((s) => {
    if (lastStatus.current === s) return;
    lastStatus.current = s;
    client.current?.setStatus(s);
  }, []);

  const reconnect = useCallback(() => setGen((g) => g + 1), []);

  // Ушул түзмөктүн башка ролдогу офлайн жазуусу (мис. ролду алмаштыргандан кийин) маектеш эмес.
  // Онлайн болсо — бул ошол эле компьютердеги экинчи өтмөк (сыноо), маектеш катары көрсөтүлөт.
  const visible = useMemo(
    () => participants.filter((p) => p.clientId === me || !isThisDevice(p.clientId) || p.online),
    [participants, me],
  );

  const partner = useMemo(() => {
    const others = visible.filter((p) => p.clientId !== me);
    if (!others.length) return null;
    const opposite = others.filter((p) => p.role !== role);
    const pool = opposite.length ? opposite : others;
    return pool.find((p) => p.online) ?? pool[0];
  }, [visible, me, role]);

  return {
    state,
    room,
    you,
    participants: visible,
    partner,
    partnerStatus: partner?.online ? partner.status : "idle",
    messages,
    error,
    incoming,
    send,
    setStatus,
    reconnect,
  };
}
