// Жест сөздүгү — браузердин IndexedDB'синде сакталат (idb-keyval).
// Бул жерде колдонуучунун жаздыруулары жана демо жесттер гана. Видео китепкана (source "library")
// IndexedDB'ге көчүрүлбөйт — ал эс тутумда (src/data/library.ts) жана useDictionary аларды бириктирет.
import { createStore, get, set, setMany, del, delMany, entries, values } from "idb-keyval";
import type { SignEntry } from "../lib/types";

const db = createStore("speak-jest", "signs");

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function onDictionaryChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const normalizeGloss = (g: string) => g.trim().toLocaleUpperCase("ky-KG");

/** IndexedDB'деги жазуулар (колдонуучунун + демо). Эски версиянын китепкана көчүрмөлөрү эске алынбайт. */
export async function listSigns(): Promise<SignEntry[]> {
  const all = ((await values<SignEntry>(db)) ?? []).filter((s) => s.source !== "library");
  return all.sort((a, b) => a.gloss.localeCompare(b.gloss, "ky"));
}

const LEGACY_KEY = "speak:legacyLibraryCleaned";

/**
 * Мурунку версия видео китепкананы (~90 МБ) IndexedDB'ге көчүргөн. Азыр ал керек эмес —
 * бир жолу өчүрөбүз (source "library" жазуулар). Колдонуучунун жаздырууларына тийбейт.
 */
export async function deleteLegacyLibrary(): Promise<number> {
  try {
    if (localStorage.getItem(LEGACY_KEY)) return 0;
  } catch {
    /* жеке режим — ар жолу текшеребиз */
  }
  const all = (await entries<string, SignEntry>(db)) ?? [];
  const keys = all.filter(([, v]) => v?.source === "library").map(([k]) => k);
  if (keys.length) await delMany(keys, db);
  try {
    localStorage.setItem(LEGACY_KEY, "1");
  } catch {
    /* ignore */
  }
  if (keys.length) emit();
  return keys.length;
}

export async function getSign(gloss: string): Promise<SignEntry | undefined> {
  return get<SignEntry>(normalizeGloss(gloss), db);
}

export async function saveSign(entry: SignEntry): Promise<void> {
  await set(normalizeGloss(entry.gloss), { ...entry, gloss: normalizeGloss(entry.gloss) }, db);
  emit();
}

/** Көп жестти бир транзакцияда сактайт (китепкана импорту үчүн). */
export async function saveMany(entries: SignEntry[]): Promise<void> {
  await setMany(entries.map((e) => [normalizeGloss(e.gloss), { ...e, gloss: normalizeGloss(e.gloss) }] as [string, SignEntry]), db);
  emit();
}

export async function deleteSign(gloss: string): Promise<void> {
  await del(normalizeGloss(gloss), db);
  emit();
}

/**
 * Демо жесттерди кошот же жаңы версиясына жаңыртат.
 * Колдонуучу жаздырган жесттерди (source: "recorded") эч качан алмаштырбайт.
 */
export async function seedIfEmpty(seeds: SignEntry[]): Promise<void> {
  for (const s of seeds) {
    const cur = await getSign(s.gloss);
    if (!cur) await set(normalizeGloss(s.gloss), s, db);
    else if (cur.source === "demo") await set(normalizeGloss(s.gloss), { ...s, samples: cur.samples, createdAt: cur.createdAt }, db);
  }
  emit();
}

export async function exportDictionary(): Promise<Blob> {
  const all = await listSigns();
  return new Blob([JSON.stringify({ version: 1, signs: all })], { type: "application/json" });
}

export async function importDictionary(file: File): Promise<number> {
  const data = JSON.parse(await file.text()) as { version: number; signs: SignEntry[] };
  if (!Array.isArray(data.signs)) throw new Error("Туура эмес файл");
  for (const s of data.signs) await set(normalizeGloss(s.gloss), s, db);
  emit();
  return data.signs.length;
}
