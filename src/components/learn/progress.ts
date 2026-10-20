// Үйрөнүү прогресси — ушул браузердин localStorage'ында (каттоосуз).
// Деңгээлдер: 0 жаңы → 1 үйрөнүлдү (карта көрүлдү) → 2 машыгылды (бир жолу туура) → 3 өздөштүрүлдү (MASTER_N жолу катары менен туура).
import { useSyncExternalStore } from "react";

export type Level = 0 | 1 | 2 | 3;
export const MASTER_N = 3;
export const DAILY_GOAL = 10;

export interface ItemProgress {
  /** деңгээл */
  l: Level;
  /** катары менен туура жооптор */
  s: number;
  /** туура / ката жооптордун жалпы саны */
  c: number;
  w: number;
  /** акыркы ката кайталала элек */
  miss?: boolean;
  /** акыркы аракет, мс */
  t: number;
}

export interface LearnState {
  v: 1;
  items: Record<string, ItemProgress>;
  /** Иш-аракет болгон күндөр ("YYYY-MM-DD"), акыркы 60 */
  days: string[];
  /** Ар бир тректеги акыркы карта */
  pos: Record<string, number>;
  /** Акыркы ачылган трек */
  last?: string;
  /** Бүгүн кайталанган элементтер */
  today: { d: string; keys: string[] };
}

const KEY = "speak:learn:v1";

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function empty(): LearnState {
  return { v: 1, items: {}, days: [], pos: {}, today: { d: dayKey(), keys: [] } };
}

function load(): LearnState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const s = JSON.parse(raw) as LearnState;
    if (s?.v !== 1 || typeof s.items !== "object") return empty();
    return { ...empty(), ...s };
  } catch {
    return empty();
  }
}

let state: LearnState = load();
const subs = new Set<() => void>();

function commit(next: LearnState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* жеке режим — прогресс ушул сессияда гана */
  }
  subs.forEach((f) => f());
}

// Башка өтмөктө өзгөрсө — жаңыртабыз
if (typeof window !== "undefined") {
  addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    state = load();
    subs.forEach((f) => f());
  });
}

/** Бүгүнкү күндү белгилейт; элемент берилсе — бүгүнкү максатка кошулат. */
function touch(s: LearnState, key?: string): LearnState {
  const d = dayKey();
  const days = s.days.at(-1) === d ? s.days : [...s.days, d].slice(-60);
  const today = s.today.d === d ? s.today : { d, keys: [] };
  const keys = key && !today.keys.includes(key) ? [...today.keys, key].slice(-200) : today.keys;
  return { ...s, days, today: { d, keys } };
}

function item(s: LearnState, key: string): ItemProgress {
  return s.items[key] ?? { l: 0, s: 0, c: 0, w: 0, t: 0 };
}

/** Карта көрүлдү → «үйрөнүлдү» */
export function markSeen(key: string) {
  const it = item(state, key);
  if (it.l >= 1 && state.today.keys.includes(key) && state.today.d === dayKey()) return;
  const s = touch(state, key);
  commit({ ...s, items: { ...s.items, [key]: { ...it, l: Math.max(it.l, 1) as Level, t: Date.now() } } });
}

/** Жооп (тест же камера): туура → катар өсөт, MASTER_N жеткенде «өздөштүрүлдү»; ката → катар нөлгө. Жаңы деңгээлди кайтарат. */
export function recordAnswer(key: string, ok: boolean): Level {
  const it = item(state, key);
  let next: ItemProgress;
  if (ok) {
    const streak = it.s + 1;
    next = { ...it, s: streak, c: it.c + 1, miss: false, l: (streak >= MASTER_N ? 3 : Math.max(it.l, 2)) as Level, t: Date.now() };
  } else {
    next = { ...it, s: 0, w: it.w + 1, miss: true, l: (it.l === 3 ? 2 : Math.max(it.l, 1)) as Level, t: Date.now() };
  }
  const s = touch(state, key);
  commit({ ...s, items: { ...s.items, [key]: next } });
  return next.l;
}

export function setPosition(track: string, index: number) {
  if (state.pos[track] === index && state.last === track) return;
  commit({ ...state, pos: { ...state.pos, [track]: index }, last: track });
}

export function resetProgress() {
  commit(empty());
}

/** Катар күндөр (бүгүн же кечээ менен бүтсө) */
export function streakOf(s: LearnState): number {
  const set = new Set(s.days);
  const d = new Date();
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(dayKey(d))) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function todayCount(s: LearnState): number {
  return s.today.d === dayKey() ? s.today.keys.length : 0;
}

export const levelOf = (s: LearnState, key: string): Level => s.items[key]?.l ?? 0;

export interface TrackStats { total: number; seen: number; practiced: number; mastered: number; ratio: number }

export function statsOf(s: LearnState, keys: string[]): TrackStats {
  let seen = 0, practiced = 0, mastered = 0, sum = 0;
  for (const k of keys) {
    const l = levelOf(s, k);
    if (l >= 1) seen++;
    if (l >= 2) practiced++;
    if (l >= 3) mastered++;
    sum += l;
  }
  return { total: keys.length, seen, practiced, mastered, ratio: keys.length ? sum / (keys.length * 3) : 0 };
}

export function useLearnState(): LearnState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

export const LEVEL_LABEL: Record<Level, string> = { 0: "Жаңы", 1: "Үйрөнүлдү", 2: "Машыгылды", 3: "Өздөштүрүлдү" };
