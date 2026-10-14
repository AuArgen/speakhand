// Видеосабактардан тартылып алынган даяр жест китепканасы (public/signs/rsl, format 2).
//
// • manifest.json эс тутумга бир жолу жүктөлөт (gzip ~70 КБ) — IndexedDB'ге көчүрүлбөйт.
// • Ар бир жесттин клиби өзүнчө кичине файл (clips/<id>.json, gzip ~7 КБ): керек болгондо гана
//   жүктөлөт — resolveClip(entry) (кичине LRU кэш + бир эле сурамды бириктирүү).
// • Таануу үчүн үлгүлөр алдын ала эсептелген: templates.json + templates.bin (loadTemplateBank).
// • Сервер (server/static-gz.ts) .gz эгиздерин Content-Encoding: gzip менен берет.
import type { MocapClip, SignClip, SignEntry } from "../lib/types";
import { decodeTemplateBank, type TemplateBank, type TemplateIndex } from "../vision/classifier";
import { decodeClip, isEncodedClip } from "./clipCodec";
import { deleteLegacyLibrary } from "./store";

const BASE = "/signs/rsl/";
const VERSION_KEY = "speak:libraryVersion";

interface ManifestItem {
  id: string;
  gloss: string;
  aliases: string[];
  ru: string;
  lesson: number;
  topic: string;
  /** format 2: "clips/<id>.json" */
  clip?: string;
  quality: number;
  frames?: number;
}

interface Manifest {
  version: number;
  format?: number;
  source: string;
  playlist?: string;
  items: ManifestItem[];
}

export interface LibraryProgress {
  done: number;
  total: number;
}

// ───────────────────────── манифест → сөздүк жазуулары ─────────────────────────

let entries: SignEntry[] = [];
let signature = "";
let manifestPromise: Promise<SignEntry[]> | null = null;
const listeners = new Set<() => void>();

export function onLibraryChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Жүктөлгөн китепкана жазуулары (жүктөлө элек болсо — бош тизме). */
export function getLibraryEntries(): SignEntry[] {
  return entries;
}

function toEntries(m: Manifest): SignEntry[] {
  const groups = new Map<string, ManifestItem[]>();
  for (const it of m.items) {
    if (!it.clip) continue;
    const list = groups.get(it.gloss);
    if (list) list.push(it);
    else groups.set(it.gloss, [it]);
  }
  const out: SignEntry[] = [];
  for (const [gloss, items] of groups) {
    // Бир глосско бир нече вариант болушу мүмкүн: эң сапаттуусу аватар үчүн.
    items.sort((a, b) => b.quality - a.quality);
    out.push({
      gloss,
      aliases: [...new Set(items.flatMap((i) => i.aliases))],
      clip: null,
      clipUrl: BASE + items[0].clip,
      samples: [],
      source: "library",
      meta: { ru: [...new Set(items.map((i) => i.ru))], lesson: items[0].lesson, topic: items[0].topic, ids: items.map((i) => i.id) },
      createdAt: 0,
    });
  }
  return out.sort((a, b) => a.gloss.localeCompare(b.gloss, "ky"));
}

/** Манифестти бир жолу жүктөйт (кайра чакырылса — ошол эле Promise). Жок болсо — бош тизме. */
export function loadLibrary(): Promise<SignEntry[]> {
  manifestPromise ??= (async () => {
    try {
      const r = await fetch(`${BASE}manifest.json`, { cache: "no-cache" });
      if (!r.ok) return [];
      const text = await r.text();
      const m = JSON.parse(text) as Manifest;
      if ((m.format ?? 1) < 2) {
        console.warn("[library] manifest format 1 — tools/rsl_import/build.py менен кайра түзүңүз");
        return [];
      }
      signature = `${m.version}:${m.format}:${m.items.length}:${text.length}`;
      entries = toEntries(m);
      listeners.forEach((l) => l());
      return entries;
    } catch (e) {
      console.warn("[library] manifest жүктөлгөн жок:", e);
      return [];
    }
  })();
  return manifestPromise;
}

// ───────────────────────── клиптер (жалкоо жүктөө + LRU) ─────────────────────────

const LRU_MAX = 64;
const clipCache = new Map<string, MocapClip>();
const inflight = new Map<string, Promise<MocapClip>>();

/** Клипти дареги боюнча жүктөп, чечет. Кэште болсо — дароо. */
export function fetchClip(url: string): Promise<MocapClip> {
  const hit = clipCache.get(url);
  if (hit) {
    clipCache.delete(url); // LRU: акыркы колдонулганды аягына
    clipCache.set(url, hit);
    return Promise.resolve(hit);
  }
  let p = inflight.get(url);
  if (!p) {
    p = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      const json: unknown = await r.json();
      const clip = isEncodedClip(json) ? decodeClip(json) : (json as MocapClip);
      if (clip?.kind !== "mocap" || !Array.isArray(clip.frames)) throw new Error(`${url}: клип эмес`);
      clipCache.set(url, clip);
      while (clipCache.size > LRU_MAX) clipCache.delete(clipCache.keys().next().value!);
      return clip;
    })().finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  return p;
}

/** Жазуунун клиби: бар болсо ошол, болбосо clipUrl боюнча жүктөлөт. Жок/ката — null. */
export async function resolveClip(entry: SignEntry | null | undefined): Promise<SignClip | null> {
  if (!entry) return null;
  if (entry.clip) return entry.clip;
  if (!entry.clipUrl) return null;
  try {
    return await fetchClip(entry.clipUrl);
  } catch (e) {
    console.warn("[library] клип жүктөлгөн жок:", entry.gloss, e);
    return null;
  }
}

/** Китепкана клибинин дареги id боюнча (варианттар үчүн). */
export const clipUrlForId = (id: string) => `${BASE}clips/${id}.json`;

// ───────────────────────── таануу үлгүлөрү ─────────────────────────

let bankPromise: Promise<TemplateBank | null> | null = null;

/** templates.json + templates.bin → TemplateBank (бир жолу). Жок же эскирген болсо — null. */
export function loadTemplateBank(): Promise<TemplateBank | null> {
  bankPromise ??= (async () => {
    try {
      const [ri, rb] = await Promise.all([fetch(`${BASE}templates.json`), fetch(`${BASE}templates.bin`)]);
      if (!ri.ok || !rb.ok) return null;
      const index = (await ri.json()) as TemplateIndex;
      return decodeTemplateBank(index, await rb.arrayBuffer());
    } catch (e) {
      console.warn("[library] таануу үлгүлөрү жүктөлгөн жок:", e);
      return null;
    }
  })();
  return bankPromise;
}

// ───────────────────────── ишке киргизүү ─────────────────────────

/**
 * Тиркеме ачылганда чакырылат: манифест + таануу үлгүлөрү жүктөлөт, IndexedDB'деги эски
 * (format 1) китепкана көчүрмөлөрү өчүрүлөт. Кайтарат: китепкана жаңы же жаңырган болсо — глосс
 * саны (билдирүү үчүн), болбосо 0.
 */
export async function syncLibrary(onProgress?: (p: LibraryProgress) => void): Promise<number> {
  onProgress?.({ done: 0, total: 2 });
  const list = await loadLibrary();
  onProgress?.({ done: 1, total: 2 });
  // Таануу үлгүлөрү (2.5 МБ) бул жерде жүктөлбөйт — аларды useRecognizer жаңсоочунун түзмөгүндө гана жүктөйт.
  await deleteLegacyLibrary().catch((e) => console.warn("[library] эски көчүрмөлөр өчүрүлгөн жок:", e));
  onProgress?.({ done: 2, total: 2 });
  if (!list.length || readVersion() === signature) return 0;
  writeVersion(signature);
  return list.length;
}

function readVersion(): string | null {
  try {
    return localStorage.getItem(VERSION_KEY);
  } catch {
    return null;
  }
}

function writeVersion(v: string) {
  try {
    localStorage.setItem(VERSION_KEY, v);
  } catch {
    /* жеке режим */
  }
}
