// Кыргызча текст → жест тилинин глосс тизмеги.
// Негизги жол: Claude (жергиликтүү CLI). Запас жол: жөнөкөй эрежелер (Claude жеткиликсиз болсо).
import { askClaudeJson, type ClaudeModel } from "./claude.ts";
import type { RawGloss } from "./phrasebook.ts";

export interface VocabItem {
  gloss: string;
  aliases: string[];
}

export interface GlossOutput {
  gloss: string[];
  fingerspell: string[];
  nonManual: { question: boolean; negation: boolean };
  /** phrasebook — даяр котормо; cache — мурун Claude которгон; rules — эрежелер; claude — жаңы AI котормо */
  engine: "phrasebook" | "cache" | "rules" | "claude";
  model?: string;
  ms?: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    gloss: {
      type: "array",
      items: { type: "string" },
      description: "Жест тартибиндеги токендер. Сөздүктөгү глосс же '#СӨЗ' (тамгалап көрсөтүү).",
    },
    question: { type: "boolean" },
    negation: { type: "boolean" },
  },
  required: ["gloss", "question", "negation"],
  additionalProperties: false,
} as const;

const SYSTEM = `Сен кыргыз тилинен кыргыз жест тилине (КЖТ) котормочусуң. КЖТ орус жест тилине жакын, өзүнчө грамматикасы бар.
Кириш: кыргызча сүйлөм (кээде сүйлөө таануудан келген, катасы болушу мүмкүн). Чыгыш: жест тилиндеги глосстордун тизмеги.

Эрежелер:
- Мүчөлөрдү, жөндөмө жана жак мүчөлөрүн, көмөкчүлөрдү таштап, сөздүн уңгусун ЧОҢ ТАМГА менен жаз (мектепке → МЕКТЕП, барам → БАР).
- Тартип: убакыт (БҮГҮН, ЭРТЕҢ, КЕЧЭЭ) биринчи → тема/субъект → объект → этиш. Суроо сөз (КАНДАЙ, ЭМНЕ, КИМ, КАЧАН, КАЙДА) аягында. Тануу (ЖОК) этиштен кийин.
- Төмөндөгү СӨЗДҮКТӨ бар глоссту колдонууга аракет кыл (синонимди да ошого бур). Сөздүктө жок, бирок маанилүү сөздү (ысым, шаар, жаңы сөз) '#' менен башта: #АЙГҮЛ. Маанисиз толтургуч сөздөрдү таштап кой.
- question = сүйлөм суроо болсо; negation = тануу болсо (бет мимикасы үчүн).
Жообуңда схемадан башка эч нерсе болбосун.`;

/** Claude'га которттурат. Натыйжа сөздүккө байланбаган (кэште сакталат, анан bindToVocabulary). */
export async function glossWithClaude(text: string, vocab: VocabItem[], model: ClaudeModel): Promise<{ raw: RawGloss; model: string; ms: number }> {
  const dict = vocab.map((v) => (v.aliases.length ? `${v.gloss} (${v.aliases.slice(0, 6).join(", ")})` : v.gloss)).join("\n");
  const res = await askClaudeJson<RawGloss>({
    system: SYSTEM,
    input: `СӨЗДҮК:\n${dict || "(бош)"}\n\nСҮЙЛӨМ: ${text}`,
    schema: SCHEMA,
    model,
  });
  return { raw: res.data, model: res.model, ms: res.ms };
}

// ---------- Запас: эреже негизиндеги котормо ----------

const TIME_WORDS = new Set(["БҮГҮН", "ЭРТЕҢ", "КЕЧЭЭ", "АЗЫР", "КИЙИН", "МУРУН", "ДАЙЫМА"]);
const QUESTION_WORDS = new Set(["КАНДАЙ", "ЭМНЕ", "КИМ", "КАЧАН", "КАЙДА", "КАНЧА", "ЭМНЕГЕ", "КАЙСЫ"]);
const FILLERS = new Set(["ЖАНА", "МЕНЕН", "ҮЧҮН", "БОЛСО", "ДА", "ДЕ", "ГО", "ЭЛЕ", "ОШОЛ", "БУЛ", "ЭКЕН", "ЧЕЙИН"]);
const NEGATION = new Set(["ЭМЕС", "ЖОК"]);

export function glossWithRules(text: string, vocab: VocabItem[]): GlossOutput {
  // Ар бир сүйлөм өзүнчө: тануу/суроо сөздөрү ошол сүйлөмдүн аягына барат.
  const parts = text.split(/(?<=[.!?…])\s+/).filter((p) => p.trim());
  const outs = parts.map((p) => glossSentence(p, vocab));
  const gloss = outs.flatMap((o) => o.gloss);
  return {
    gloss,
    fingerspell: gloss.filter((g) => g.startsWith("#")).map((g) => g.slice(1)),
    nonManual: { question: outs.some((o) => o.question), negation: outs.some((o) => o.negation) },
    engine: "rules",
  };
}

// Кыргыз мүчөлөрү (үндүүлөрдүн шайкештиги менен). Уңгудан кийинки бөлүк ушулардын тизмеги болушу керек —
// болбосо «Айбек» → АЙ сыяктуу ката чыгат.
const V = "[АЕОӨ]";
const I = "[ЫИУҮ]";
const SUFFIX = [
  `[ЛДТН]${V}Р`, // көптүк: -лар, -дер, -тор
  `${I}?М`, `${I}?Ң`, `С?${I}`, `${I}?Б${I}З`, `${I}?Ң${I}З`, // таандык
  `[НДТ]${I}Н`, `[ГКН]?${V}`, `[НДТ]?${I}`, "Н", `Н?[ДТ]${V}`, `[ДТН]${V}Н`, "МЕНЕН", `Ч${V}`, // жөндөмө
  `${V}?Й?[МТ]`, `${V}?Й?Б${I}З`, `${V}?Й?С${I}[ҢЗ]`, `[ДТ]${I}[МҢК]?`, `[ГК]${V}Н`, `${I}?П`, // этиш
  `[БПМ]${V}`, `[ГК]${I}`, `С${V}`, `[ГК]${I}Л${V}`, `[МП]${I}[НЗ]`, `[ЧЖ]${I}`, "УУ", "ҮҮ", `${V}Р`, `${I}Р`,
  `Л${I}К`, `Ч${I}Л${I}К`, `${I}Ш`, `К${I}Ч`, `[ГК]${V}Ч`, `[ГК]${I}Ч`, `Д${I}Р`,
].join("|");
const SUFFIX_CHAIN = new RegExp(`^(?:${SUFFIX}){1,4}$`);

/** Сөз = уңгу + мүчөлөр? */
function stemMatches(word: string, stem: string): boolean {
  if (word === stem) return true;
  if (!word.startsWith(stem) || stem.length < 2) return false;
  const rest = word.slice(stem.length);
  if (stem.length === 2 && rest.length > 4) return false;
  return SUFFIX_CHAIN.test(rest);
}

interface Lexicon {
  /** Бир сөздүү формалар: так дал келүү (глосстун өз аты артыкчылыктуу) */
  exact: Map<string, string>;
  /** Уңгулар — эң узуну биринчи */
  stems: { stem: string; gloss: string }[];
  /** Көп сөздүү фразалар (токендер) — эң узуну биринчи */
  phrases: { tokens: string[]; gloss: string }[];
}

let lexCache: { key: VocabItem[]; lex: Lexicon } | null = null;

function buildLexicon(vocab: VocabItem[]): Lexicon {
  if (lexCache?.key === vocab) return lexCache.lex;
  const exact = new Map<string, string>();
  const aliasExact = new Map<string, string>();
  const stems: Lexicon["stems"] = [];
  const phrases: Lexicon["phrases"] = [];
  const seenPhrase = new Set<string>();
  for (const v of vocab) {
    const multi = v.gloss.includes(" ");
    for (const raw of [v.gloss, ...v.aliases]) {
      const form = raw.toLocaleUpperCase("ky-KG").trim();
      if (!form) continue;
      if (form.includes(" ")) {
        const k = `${form}|${v.gloss}`;
        if (!seenPhrase.has(k)) { seenPhrase.add(k); phrases.push({ tokens: form.split(/\s+/), gloss: v.gloss }); }
      } else if (!multi) {
        // Фраза-жесттин жалгыз сөздүү алиасы («кайда» → СЕН КАЙДА ЖАШАЙСЫҢ) жөнөкөй сөздү ээлебеши керек.
        if (form === v.gloss) exact.set(form, v.gloss);
        else if (!aliasExact.has(form)) aliasExact.set(form, v.gloss);
        stems.push({ stem: form, gloss: v.gloss });
      }
    }
  }
  for (const [form, g] of aliasExact) if (!exact.has(form)) exact.set(form, g);
  stems.sort((a, b) => b.stem.length - a.stem.length);
  phrases.sort((a, b) => b.tokens.length - a.tokens.length || b.tokens.join("").length - a.tokens.join("").length);
  const lex = { exact, stems, phrases };
  lexCache = { key: vocab, lex };
  return lex;
}

function glossSentence(text: string, vocab: VocabItem[]): { gloss: string[]; question: boolean; negation: boolean } {
  const original = text.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(Boolean);
  const words = original.map((w) => w.toLocaleUpperCase("ky-KG"));
  const lex = buildLexicon(vocab);

  // 1) Фраза-жесттер: «Сен кайда жашайсың» → бир жест. Акыркы сөз мүчө менен келиши мүмкүн.
  const units: { gloss: string | null; word: string; index: number }[] = [];
  for (let i = 0; i < words.length; ) {
    const ph = lex.phrases.find(
      (p) =>
        i + p.tokens.length <= words.length &&
        p.tokens.every((t, j) => words[i + j] === t || (j === p.tokens.length - 1 && stemMatches(words[i + j], t))),
    );
    if (ph) {
      units.push({ gloss: ph.gloss, word: ph.tokens.join(" "), index: i });
      i += ph.tokens.length;
    } else {
      units.push({ gloss: null, word: words[i], index: i });
      i++;
    }
  }

  const time: string[] = [];
  const body: string[] = [];
  const tail: string[] = [];
  let negation = false;
  let question = /\?\s*$/.test(text.trim());

  for (const u of units) {
    const w = u.word;
    let g = u.gloss;
    if (!g) {
      if (FILLERS.has(w)) continue;
      if (NEGATION.has(w)) { negation = true; continue; }
      // Терс этиш: бар-ба-йм, кел-бе-йт, көр-гө-н жок ж.б.
      if (/(БА|БЕ|БО|БӨ|ПА|ПЕ|ПО|ПӨ|МА|МЕ|МО|МӨ)(ЙМ|ЙМЫН|ЙСЫҢ|ЙТ|ЙБЫЗ|ДЫ|ДИ|ДУ|ДҮ)$/.test(w)) negation = true;
      // Сүйлөмдүн ортосунда баш тамга менен жазылган сөз — ысым же жер аты: тамгалап көрсөтөбүз.
      const isName = u.index > 0 && /^\p{Lu}/u.test(original[u.index]) && !lex.exact.has(w);
      g = (isName ? undefined : lex.exact.get(w) ?? lex.stems.find((s) => stemMatches(w, s.stem))?.gloss) ?? `#${w}`;
    }
    if (TIME_WORDS.has(g)) time.push(g);
    else if (QUESTION_WORDS.has(g)) { tail.push(g); question = true; }
    else if (NEGATION.has(g)) negation = true;
    else body.push(g);
  }
  if (negation) tail.unshift("ЖОК");
  return { gloss: [...time, ...body, ...tail], question, negation };
}

// ---------- Тескери багыт: глосстор → табигый кыргызча сүйлөм ----------

const SENTENCE_SCHEMA = {
  type: "object",
  properties: { sentence: { type: "string" } },
  required: ["sentence"],
  additionalProperties: false,
} as const;

const SENTENCE_SYSTEM = `Кыргыз жест тилинен (КЖТ) таанылган глосстордун тизмеги берилет (жест тартибинде, мүчөсүз).
Аны табигый, грамматикалык туура кыргызча бир же эки сүйлөмгө айландыр: мүчөлөрдү, жак жана чак мүчөлөрүн кош, сөз тартибин оңдо.
'#' менен башталган сөз — тамгалап көрсөтүлгөн ысым же жаңы сөз. Мааниге кошумча нерсе ойлоп чыгарба. question=true болсо — суроо сүйлөм.`;

export async function sentenceWithClaude(gloss: string[], question: boolean, model: ClaudeModel): Promise<{ sentence: string; model: string; ms: number }> {
  const res = await askClaudeJson<{ sentence: string }>({
    system: SENTENCE_SYSTEM,
    input: `ГЛОССТОР: ${gloss.join(" ")}\nquestion=${question}`,
    schema: SENTENCE_SCHEMA,
    model,
  });
  return { sentence: res.data.sentence.trim(), model: res.model, ms: res.ms };
}

/** Claude жок болсо: глосстарды кичине тамга менен бириктирүү. */
export function sentenceWithRules(gloss: string[], question: boolean): string {
  const s = gloss.map((g) => g.replace(/^#/, "").toLocaleLowerCase("ky-KG")).join(" ");
  return s ? s[0].toLocaleUpperCase("ky-KG") + s.slice(1) + (question ? "?" : ".") : "";
}
