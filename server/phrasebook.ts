// Даяр котормолор: алдын ала даярдалган сүйлөмдөр + Claude бир жолу которгон сүйлөмдөрдүн туруктуу кэши.
// Максат — ар бир сүйлөм үчүн AI'ды чакырбоо.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GlossOutput, VocabItem } from "./gloss.ts";

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "data");
const PHRASEBOOK_FILE = path.join(DATA, "phrasebook.json");
// AI котормолорунун кэши: DATA_DIR берилсе (мис. Docker volume) — ошол жакта, контейнер жаңырса да сакталат.
const CACHE_FILE = path.join(process.env.DATA_DIR || DATA, "gloss-cache.json");

/** Сүйлөмдүн «жылаңач» котормосу — сөздүккө байланбаган. */
export interface RawGloss {
  gloss: string[];
  question: boolean;
  negation: boolean;
}

interface PhraseItem extends RawGloss {
  text: string;
}

interface CacheItem extends RawGloss {
  model: string;
  at: string;
}

/** Салыштыруу үчүн: кичине тамга, тыныш белгилерсиз, бир боштук. */
export function normalizeText(text: string): string {
  return text
    .toLocaleLowerCase("ky-KG")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
  } catch (e) {
    console.warn(`${path.basename(file)} окулбай калды:`, (e as Error).message);
    return fallback;
  }
}

const phrasebook = new Map<string, PhraseItem>();
for (const item of readJsonFile<{ items: PhraseItem[] }>(PHRASEBOOK_FILE, { items: [] }).items) {
  phrasebook.set(normalizeText(item.text), item);
}

const cache = new Map<string, CacheItem>(Object.entries(readJsonFile<Record<string, CacheItem>>(CACHE_FILE, {})));

export const phrasebookSize = () => phrasebook.size;
export const cacheSize = () => cache.size;

/** Даяр сүйлөмдөрдүн тизмеси (бөлмөдөгү тез жооптор үчүн), файлдагы тартипте. */
export function listPhrases(): PhraseItem[] {
  return [...phrasebook.values()].map((p) => ({
    text: p.text,
    gloss: [...p.gloss],
    question: Boolean(p.question),
    negation: Boolean(p.negation),
  }));
}

export function lookupPhrase(text: string): RawGloss | undefined {
  return phrasebook.get(normalizeText(text));
}

export function lookupCache(text: string): CacheItem | undefined {
  return cache.get(normalizeText(text));
}

let saveTimer: NodeJS.Timeout | null = null;
export function rememberTranslation(text: string, raw: RawGloss, model: string) {
  cache.set(normalizeText(text), { ...raw, model, at: new Date().toISOString() });
  // Бир нече котормону топтоп, дискке бир жолу жазабыз.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const sorted = Object.fromEntries([...cache.entries()].sort(([a], [b]) => a.localeCompare(b, "ky")));
    await writeFile(CACHE_FILE, JSON.stringify(sorted, null, 1) + "\n", "utf8");
  }, 1000);
}

/** Жылаңач котормону учурдагы сөздүккө байлайт: сөздүктө жок глосс тамгалап көрсөтүлөт. */
export function bindToVocabulary(raw: RawGloss, vocab: VocabItem[], engine: GlossOutput["engine"], model?: string): GlossOutput {
  const known = new Set(vocab.map((v) => v.gloss));
  const gloss = raw.gloss
    .map((g) => g.replace(/_/g, " ").trim().toLocaleUpperCase("ky-KG"))
    .filter(Boolean)
    .map((g) => (g.startsWith("#") || known.has(g) ? g : `#${g}`));
  return {
    gloss,
    fingerspell: gloss.filter((g) => g.startsWith("#")).map((g) => g.slice(1)),
    nonManual: { question: raw.question, negation: raw.negation },
    engine,
    model,
  };
}
