// Сервер тараптагы сөздүк: видео китепкана (public/signs/rsl/manifest.json) + демо жесттер.
// Кардар ар бир сурамда 1300 жестти жибербеши үчүн — ал өз жаздырууларын гана кошот.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SIGNS } from "../src/avatar/seeds.ts";
import type { VocabItem } from "./gloss.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATES = [path.join(ROOT, "public/signs/rsl/manifest.json"), path.join(ROOT, "dist/signs/rsl/manifest.json")];

let cached: { mtime: number; file: string; vocab: VocabItem[] } | null = null;

/** Китепкана + демо. Манифест өзгөрсө (кайра курулса) автоматтык жаңыланат. */
export function serverVocabulary(): VocabItem[] {
  const file = CANDIDATES.find((f) => existsSync(f));
  const mtime = file ? statSync(file).mtimeMs : 0;
  if (cached && cached.file === (file ?? "") && cached.mtime === mtime) return cached.vocab;

  const byGloss = new Map<string, Set<string>>();
  const add = (gloss: string, aliases: string[]) => {
    const set = byGloss.get(gloss) ?? new Set<string>();
    for (const a of aliases) if (a) set.add(a);
    byGloss.set(gloss, set);
  };
  for (const s of DEMO_SIGNS) add(s.gloss, s.aliases);
  if (file) {
    try {
      const items = (JSON.parse(readFileSync(file, "utf8")) as { items: { gloss: string; aliases: string[] }[] }).items;
      for (const it of items) if (it.gloss && !it.gloss.startsWith("#")) add(it.gloss, it.aliases ?? []);
    } catch (e) {
      console.warn("Китепкананын манифести окулбай калды:", (e as Error).message);
    }
  }
  const vocab = [...byGloss].map(([gloss, a]) => ({ gloss, aliases: [...a] }));
  cached = { mtime, file: file ?? "", vocab };
  return vocab;
}

/** Сервердин сөздүгүнө кардардын өз жесттерин (Студияда жаздырылган) кошот. */
export function withClientVocabulary(client: VocabItem[]): VocabItem[] {
  const base = serverVocabulary();
  if (!client.length) return base;
  const known = new Map(base.map((v) => [v.gloss, v]));
  const extra: VocabItem[] = [];
  for (const v of client) {
    const prev = known.get(v.gloss);
    if (!prev) extra.push(v);
    else if (v.aliases.some((a) => !prev.aliases.includes(a))) {
      known.set(v.gloss, { gloss: v.gloss, aliases: [...new Set([...prev.aliases, ...v.aliases])] });
    }
  }
  return [...known.values(), ...extra];
}
