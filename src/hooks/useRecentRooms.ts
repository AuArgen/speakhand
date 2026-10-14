// Акыркы бөлмөлөр — localStorage. Ошол эле код менен сүйлөшүүнү бир басуу менен улантуу үчүн.
import { useCallback, useEffect, useState } from "react";
import type { Role } from "../lib/room";

export interface RecentRoom {
  code: string;
  role: Role;
  name: string;
  /** акыркы кирүү, мс */
  at: number;
  /** экинчи тараптын аты (белгилүү болсо) */
  partner?: string;
}

const KEY = "speak:recentRooms";
const MAX = 8;
const EVT = "speak:recentRooms";

export function loadRecentRooms(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentRoom[]) : [];
    return Array.isArray(list) ? list.filter((r) => /^\d{6}$/.test(r.code)) : [];
  } catch {
    return [];
  }
}

function persist(list: RecentRoom[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* жеке режим */
  }
  dispatchEvent(new Event(EVT));
}

export function rememberRoom(entry: Omit<RecentRoom, "at"> & { at?: number }) {
  const list = loadRecentRooms().filter((r) => r.code !== entry.code);
  const prev = loadRecentRooms().find((r) => r.code === entry.code);
  list.unshift({ ...prev, ...entry, at: entry.at ?? Date.now() });
  persist(list);
}

export function forgetRoom(code: string) {
  persist(loadRecentRooms().filter((r) => r.code !== code));
}

export function recentRoom(code: string): RecentRoom | undefined {
  return loadRecentRooms().find((r) => r.code === code);
}

export function useRecentRooms(): { rooms: RecentRoom[]; remember: typeof rememberRoom; forget: typeof forgetRoom } {
  const [rooms, setRooms] = useState<RecentRoom[]>(loadRecentRooms);
  useEffect(() => {
    const sync = () => setRooms(loadRecentRooms());
    addEventListener(EVT, sync);
    addEventListener("storage", sync);
    return () => {
      removeEventListener(EVT, sync);
      removeEventListener("storage", sync);
    };
  }, []);
  const remember = useCallback<typeof rememberRoom>((e) => rememberRoom(e), []);
  const forget = useCallback<typeof forgetRoom>((c) => forgetRoom(c), []);
  return { rooms, remember, forget };
}

/** Колдонуучунун аты (бир жолу жазылат, эстелет). */
export function loadName(): string {
  try {
    return localStorage.getItem("speak:name") ?? "";
  } catch {
    return "";
  }
}
export function saveName(name: string) {
  try {
    localStorage.setItem("speak:name", name.trim());
  } catch {
    /* жеке режим */
  }
}
