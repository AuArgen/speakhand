// Таанылган жесттер (глосстор) → кыргызча сүйлөм. AI'сыз, дароо.
// 1) Даяр сүйлөмдөр китепчесинен тескери издөө (глосстор так дал келсе — табигый сүйлөм).
// 2) Болбосо: ар бир глосс үчүн сөздүктөгү негизги сөз формасы + суроо/чекит.
import type { PhraseItem } from "./room";
import type { SignEntry } from "./types";

const QUESTION = new Set(["КАНДАЙ", "ЭМНЕ", "КИМ", "КАЧАН", "КАЙДА", "КАНЧА", "ЭМНЕГЕ", "КАЙСЫ"]);

const key = (gloss: string[]) => gloss.map((g) => g.trim().toLocaleUpperCase("ky-KG")).join(" ");

/** Китепчеден тескери индекс: глосс тизмеги → эң кыска сүйлөм. Бир жолу түзүп, кайра колдонуңуз. */
export function indexPhrases(phrases: PhraseItem[]): Map<string, PhraseItem> {
  const map = new Map<string, PhraseItem>();
  for (const p of phrases) {
    const k = key(p.gloss);
    const prev = map.get(k);
    if (!prev || p.text.length < prev.text.length) map.set(k, p);
  }
  return map;
}

const capitalize = (s: string) => (s ? s[0].toLocaleUpperCase("ky-KG") + s.slice(1) : s);

export interface Composed {
  text: string;
  /** "phrase" — даяр сүйлөм табылды; "words" — сөздөрдөн түзүлдү */
  source: "phrase" | "words";
  question: boolean;
}

export function composeSentence(gloss: string[], opts: { phrases: Map<string, PhraseItem>; signs: SignEntry[] }): Composed {
  const clean = gloss.filter((g) => g.trim());
  if (!clean.length) return { text: "", source: "words", question: false };

  const hit = opts.phrases.get(key(clean));
  if (hit) return { text: hit.text, source: "phrase", question: hit.question };

  const byGloss = new Map(opts.signs.map((s) => [s.gloss, s]));
  const words = clean.map((g) => {
    if (g.startsWith("#")) return capitalize(g.slice(1).toLocaleLowerCase("ky-KG"));
    // Сандар жана тамгалар өзүнчө; калганы — сөздүктөгү биринчи (негизги) сөз формасы.
    if (/^\d+$/.test(g)) return g;
    const base = byGloss.get(g)?.aliases.find((a) => a && !/\d/.test(a));
    return base ?? g.toLocaleLowerCase("ky-KG");
  });
  const question = clean.some((g) => QUESTION.has(g.toLocaleUpperCase("ky-KG")));
  return { text: capitalize(words.join(" ")) + (question ? "?" : "."), source: "words", question };
}
