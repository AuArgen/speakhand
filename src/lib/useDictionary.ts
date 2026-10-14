import { useEffect, useState } from "react";
import { getLibraryEntries, loadLibrary, onLibraryChange } from "../data/library";
import { getSign, listSigns, normalizeGloss, onDictionaryChange } from "../data/store";
import type { SignEntry } from "./types";

/**
 * Сөздүктүн бириктирилген көрүнүшү. Артыкчылык: колдонуучу жаздырган > видео китепкана > демо.
 * Жогорку булак төмөнкүнүн сөз формаларын (aliases) жана meta'сын мурастайт; клиби жок болсо —
 * төмөнкүнүн клибин (clipUrl) колдонот.
 */
export function mergeDictionary(stored: SignEntry[], library: SignEntry[]): SignEntry[] {
  const map = new Map<string, SignEntry>();
  const put = (e: SignEntry) => {
    const prev = map.get(e.gloss);
    if (!prev) {
      map.set(e.gloss, e);
      return;
    }
    map.set(e.gloss, {
      ...e,
      aliases: [...new Set([...e.aliases, ...prev.aliases])],
      meta: e.meta ?? prev.meta,
      clip: e.clip ?? prev.clip,
      clipUrl: e.clip ? e.clipUrl : e.clipUrl ?? prev.clipUrl,
    });
  };
  for (const s of stored) if (s.source === "demo") put(s);
  for (const s of library) put(s);
  for (const s of stored) if (s.source === "recorded") put(s);
  return [...map.values()].sort((a, b) => a.gloss.localeCompare(b.gloss, "ky"));
}

// Модуль деңгээлиндеги кэш: бир нече компонент бир эле тизмени бөлүшөт.
let merged: SignEntry[] = [];
let ready = false;
let version = 0;
let pending: Promise<void> | null = null;
const subs = new Set<() => void>();

async function refresh(): Promise<void> {
  const v = ++version;
  const [stored] = await Promise.all([listSigns(), loadLibrary()]);
  if (v !== version) return; // жаңыраак refresh бар
  merged = mergeDictionary(stored, getLibraryEntries());
  ready = true;
  subs.forEach((f) => f());
}

let wired = false;
function ensureWired() {
  if (wired) return;
  wired = true;
  const again = () => void (pending = refresh());
  onDictionaryChange(again);
  onLibraryChange(again);
  again();
}

/** Бир глосс боюнча бириктирилген жазуу (Студия ж.б. үчүн). */
export async function findSign(gloss: string): Promise<SignEntry | undefined> {
  const g = normalizeGloss(gloss);
  const [stored] = await Promise.all([getSign(g), loadLibrary()]);
  const lib = getLibraryEntries().find((e) => e.gloss === g);
  const list = mergeDictionary(stored && stored.source !== "library" ? [stored] : [], lib ? [lib] : []);
  return list[0];
}

/** Сөздүктүн учурдагы абалы — өзгөргөндө автоматтык жаңыланат. */
export function useDictionary(): { signs: SignEntry[]; loading: boolean } {
  const [state, setState] = useState(() => ({ signs: merged, loading: !ready }));
  useEffect(() => {
    ensureWired();
    const on = () => setState({ signs: merged, loading: !ready });
    subs.add(on);
    if (ready) on();
    else void pending?.then(on);
    return () => {
      subs.delete(on);
    };
  }, []);
  return state;
}
