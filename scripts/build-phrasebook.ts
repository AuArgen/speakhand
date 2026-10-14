// Даяр котормо китепчесин түзөт: scripts/phrases.txt → server/data/phrasebook.json.
// AI (жергиликтүү Claude CLI) бир гана жолу — ушул скрипт иштегенде — колдонулат;
// андан кийин тиркеме бул сүйлөмдөрдү AI'сыз дароо которот.
//
//   npm run phrasebook            — жаңы сүйлөмдөрдү гана которот
//   npm run phrasebook -- --all   — баарын кайра которот (мис., сөздүк чоңойгондо)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askClaudeJson, type ClaudeModel } from "../server/claude.ts";
import { normalizeText, type RawGloss } from "../server/phrasebook.ts";
import type { VocabItem } from "../server/gloss.ts";
import { DEMO_SIGNS } from "../src/avatar/seeds.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHRASES = path.join(ROOT, "scripts/phrases.txt");
const OUT = path.join(ROOT, "server/data/phrasebook.json");
const LIBRARY = path.join(ROOT, "public/signs/rsl/manifest.json");
const MODEL: ClaudeModel = (process.argv.find((a) => a.startsWith("--model="))?.slice(8) as ClaudeModel) ?? "sonnet";
const ALL = process.argv.includes("--all");
const BATCH = 20;

interface Item extends RawGloss {
  text: string;
}

function vocabulary(): VocabItem[] {
  const byGloss = new Map<string, Set<string>>();
  const add = (g: string, aliases: string[]) => {
    const set = byGloss.get(g) ?? new Set<string>();
    aliases.forEach((a) => set.add(a));
    byGloss.set(g, set);
  };
  for (const s of DEMO_SIGNS) add(s.gloss, s.aliases);
  if (existsSync(LIBRARY)) {
    const lib = JSON.parse(readFileSync(LIBRARY, "utf8")) as { items: { gloss: string; aliases: string[] }[] };
    for (const it of lib.items) if (!it.gloss.startsWith("#")) add(it.gloss, it.aliases);
  }
  return [...byGloss].map(([gloss, a]) => ({ gloss, aliases: [...a] }));
}

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          gloss: { type: "array", items: { type: "string" } },
          question: { type: "boolean" },
          negation: { type: "boolean" },
        },
        required: ["text", "gloss", "question", "negation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const SYSTEM = `Сен кыргыз тилинен кыргыз жест тилине (КЖТ, орус жест тилине жакын) котормочусуң.
Ар бир сүйлөм үчүн жест тартибиндеги глосстордун тизмегин бер:
- Мүчөлөрдү таштап, уңгуну ЧОҢ ТАМГА менен жаз (мектепке → МЕКТЕП, барам → БАР).
- Тартип: убакыт → тема/субъект → объект → этиш; суроо сөз аягында; тануу (ЖОК) этиштен кийин.
- СӨЗДҮКТӨГҮ глосстарды колдон (синонимди да ошого бур). Сөздүктө жок маанилүү сөз (ысым, шаар) '#' менен: #АЙГҮЛ. Сөздүктө жок жалпы сөздү уңгусу менен жаза бер (ал тамгаланат).
- question — суроо сүйлөм; negation — тануу.
"text" талаасына сүйлөмдү өзгөртпөй кайтар. Ар бир кирген сүйлөмгө бир жооп.`;

const phrases = readFileSync(PHRASES, "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const existing: Item[] = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { items: Item[] }).items : [];
const done = new Map(ALL ? [] : existing.map((i) => [normalizeText(i.text), i]));
const todo = phrases.filter((p) => !done.has(normalizeText(p)));
const vocab = vocabulary();
const dict = vocab.map((v) => (v.aliases.length ? `${v.gloss} (${v.aliases.slice(0, 5).join(", ")})` : v.gloss)).join("\n");

console.log(`Сөздүк: ${vocab.length} глосс · сүйлөмдөр: ${phrases.length} · которула турганы: ${todo.length} · модель: ${MODEL}`);

/** Учурдагы абалды дискке жазат — үзүлсө да жасалган иш жоголбойт. */
function save(): Item[] {
  // phrases.txt'тен өчүрүлгөн сүйлөмдөр китепчеден да чыгат.
  const items = phrases.map((p) => done.get(normalizeText(p))).filter((x): x is Item => Boolean(x));
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ version: 1, model: MODEL, vocabulary: vocab.length, generatedAt: new Date().toISOString(), items }, null, 1) + "\n",
    "utf8",
  );
  return items;
}

async function translateBatch(batch: string[]) {
  const res = await askClaudeJson<{ items: Item[] }>({
    system: SYSTEM,
    input: `СӨЗДҮК:\n${dict}\n\nСҮЙЛӨМДӨР:\n${batch.map((b, j) => `${j + 1}. ${b}`).join("\n")}`,
    schema: SCHEMA,
    model: MODEL,
    timeoutMs: 300_000,
  });
  // Модель text'ти бир аз өзгөртсө да, тартиби боюнча баштапкы сүйлөмгө байлайбыз.
  batch.forEach((text, j) => {
    const r = res.data.items.find((x) => normalizeText(x.text) === normalizeText(text)) ?? res.data.items[j];
    if (r) done.set(normalizeText(text), { text, gloss: r.gloss.map((g) => g.trim().toLocaleUpperCase("ky-KG")), question: r.question, negation: r.negation });
  });
  return res.ms;
}

let failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  try {
    let ms: number;
    try {
      ms = await translateBatch(batch);
    } catch (e) {
      console.warn(`  кайра аракет: ${(e as Error).message}`);
      ms = await translateBatch(batch);
    }
    save();
    console.log(`  ${Math.min(i + BATCH, todo.length)}/${todo.length} · ${(ms / 1000).toFixed(1)} с`);
  } catch (e) {
    failed += batch.length;
    console.error(`  ✗ ${batch.length} сүйлөм которулган жок: ${(e as Error).message}`);
  }
}

const items = save();
if (failed) console.log(`! ${failed} сүйлөм которулган жок — скриптти кайра иштетиңиз (которулгандары сакталды).`);
console.log(`✓ ${items.length} сүйлөм → ${path.relative(ROOT, OUT)}`);
