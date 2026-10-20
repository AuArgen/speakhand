// "Сүйлөшүү" сөздүгү — таануу үчүн демейки чектелген глосс тизмеси (src/data/conversationVocab.ts).
//   npx tsx scripts/build-conversation-vocab.ts
// Булагы: server/data/phrasebook.json'догу бардык глосстор (китепканада барлары) + күнүмдүк
// темалардагы сабактар (таанышуу, үй-бүлө, сезимдер, кеңири фразалар, убакыт, грамматика).
// Чоң сөздүк (1283 глосс) менен салыштырганда окшош жесттердин чаташуусу бир топ азаят.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
interface Item { gloss: string; lesson: number; topic: string; clip?: string }
const man = JSON.parse(readFileSync(path.join(ROOT, "public/signs/rsl/manifest.json"), "utf8")) as { items: Item[] };
const pb = JSON.parse(readFileSync(path.join(ROOT, "server/data/phrasebook.json"), "utf8")) as { items: { gloss: string[] }[] };

const lib = new Set(man.items.filter((i) => i.clip).map((i) => i.gloss));
/** Күнүмдүк темалар (сабак номерлери) */
const LESSONS = new Set([3, 5, 22, 27, 28]);
const out = new Set<string>();
for (const it of pb.items) for (const g of it.gloss) if (lib.has(g)) out.add(g);
const fromPhrasebook = out.size;
for (const it of man.items) if (it.clip && LESSONS.has(it.lesson)) out.add(it.gloss);
const list = [...out].sort((a, b) => a.localeCompare(b, "ky"));

const src = `// Автоматтык түрдө түзүлгөн: npx tsx scripts/build-conversation-vocab.ts (өзгөртпөңүз).
// "Сүйлөшүү" режиминде таанылуучу глосстор: сүйлөмдөр китебиндеги (${fromPhrasebook}) + күнүмдүк темалар
// (сабактар ${[...LESSONS].join(", ")}). Бардыгы ${list.length} глосс (китепканада ${lib.size}).
export const CONVERSATION_VOCAB: readonly string[] = ${JSON.stringify(list)};
`;
writeFileSync(path.join(ROOT, "src/data/conversationVocab.ts"), src);
console.log(`${list.length} glosses (${fromPhrasebook} from phrasebook) → src/data/conversationVocab.ts`);
