// «Үйрөнүү» курсу: сөздүктөн (видео китепкана) жана даяр сүйлөмдөрдөн тректер түзүлөт.
import type { PhraseItem } from "../../lib/room";
import { TOPIC_KY, wordLabel } from "../../lib/topics";
import type { SignEntry } from "../../lib/types";

export interface LearnItem {
  /** Прогресс ачкычы: "s:<ГЛОСС>" же "p:<сүйлөм>" */
  key: string;
  kind: "sign" | "phrase";
  /** Кыргызча сөз же сүйлөм */
  title: string;
  /** Орусча түп нуска (видеосабактан) */
  ru?: string;
  /** Аватар ойното турган глосстор (жест үчүн бирөө) */
  gloss: string[];
  entry?: SignEntry;
}

export interface Track {
  /** "l3" (сабак), "phrases", "review", "mine" */
  id: string;
  title: string;
  desc: string;
  emoji: string;
  kind: "signs" | "phrases";
  /** Негизги (эң керектүү) темалар картада алдыда */
  core: boolean;
  items: LearnItem[];
}

interface TopicMeta { title: string; desc: string; emoji: string; core?: boolean }

/** Тема → кыргызча аталыш, кыскача мазмун, белги. Тартиби — картадагы тартип. */
const TOPICS: [string, TopicMeta][] = [
  ["Знакомство", { title: "Саламдашуу, таанышуу", desc: "Мен, сен, сиз, ысым, салам", emoji: "👋", core: true }],
  ["Распространенные фразы", { title: "Күнүмдүк сөздөр", desc: "Кутман таң, рахмат, жардам", emoji: "💬", core: true }],
  ["Родство, семья", { title: "Үй-бүлө", desc: "Апа, ата, бир тууган, бала", emoji: "👨‍👩‍👧", core: true }],
  ["Посуда, продукты", { title: "Тамак-аш", desc: "Нан, суу, чай, идиш", emoji: "🍞", core: true }],
  ["Время, календарь, времена года", { title: "Убакыт", desc: "Бүгүн, эртең, күн, ай, жыл", emoji: "🕒", core: true }],
  ["Эмоции, чувства, состояние", { title: "Сезимдер", desc: "Кубаныч, кайгы, коркуу", emoji: "💛", core: true }],
  ["Медицина", { title: "Жардам, медицина", desc: "Оору, дарыгер, дары", emoji: "🩺", core: true }],
  ["Цифры", { title: "Сандар", desc: "1, 2, 3 … 1000", emoji: "🔢", core: true }],
  ["Алфавит", { title: "Алфавит", desc: "Тамгалап көрсөтүү (дактиль)", emoji: "🔤", core: true }],
  ["Человек", { title: "Адам", desc: "Дене, мүнөз, жаш", emoji: "🧍" }],
  ["Дом", { title: "Үй", desc: "Бөлмө, эшик, терезе", emoji: "🏠" }],
  ["Домашние вещи", { title: "Үй буюмдары", desc: "Стол, отургуч, телефон", emoji: "🛋️" }],
  ["Одежда, обувь", { title: "Кийим", desc: "Көйнөк, бут кийим, шапке", emoji: "👕" }],
  ["Цвета", { title: "Түстөр", desc: "Кызыл, көк, ак, кара", emoji: "🎨" }],
  ["Город, транспорт", { title: "Шаар, транспорт", desc: "Көчө, автобус, дүкөн", emoji: "🚌" }],
  ["Школа", { title: "Мектеп", desc: "Сабак, мугалим, китеп", emoji: "📚" }],
  ["Профессия, работа", { title: "Кесип, иш", desc: "Дарыгер, мугалим, айдоочу", emoji: "💼" }],
  ["Природа", { title: "Жаратылыш", desc: "Тоо, суу, аба ырайы", emoji: "🏔️" }],
  ["В мире животных", { title: "Жаныбарлар", desc: "Ит, мышык, ат, куш", emoji: "🐎" }],
  ["Растения", { title: "Өсүмдүктөр", desc: "Дарак, гүл, жемиш", emoji: "🌿" }],
  ["Спорт и отдых", { title: "Спорт, эс алуу", desc: "Футбол, сейил, оюн", emoji: "⚽" }],
  ["Путешествие", { title: "Саякат", desc: "Жол, мейманкана, билет", emoji: "✈️" }],
  ["Государство, страны мира", { title: "Өлкөлөр", desc: "Мамлекет, шаарлар", emoji: "🌍" }],
  ["Интеллектуальная деятельность", { title: "Ой жүгүртүү", desc: "Билүү, ойлоо, түшүнүү", emoji: "🧠" }],
  ["Антонимы", { title: "Антонимдер", desc: "Чоң — кичине, жакшы — жаман", emoji: "↔️" }],
  ["Право, закон", { title: "Укук", desc: "Мыйзам, сот, укук", emoji: "⚖️" }],
  ["Религия", { title: "Дин", desc: "Ишеним, майрам", emoji: "🕊️" }],
  ["Грамматика", { title: "Грамматика", desc: "Суроо, тануу, кызмат сөздөр", emoji: "✍️" }],
];

const lessonOf = (e: SignEntry) => e.meta?.lesson ?? 99;
const orderId = (e: SignEntry) => e.meta?.ids?.[0] ?? e.gloss;

export function signItem(e: SignEntry): LearnItem {
  const letter = /^#.$/u.test(e.gloss);
  const title = letter ? e.gloss.slice(1) : wordLabel(e);
  return {
    key: `s:${e.gloss}`,
    kind: "sign",
    title: letter ? title.toLocaleUpperCase("ky-KG") : title,
    ru: e.meta?.ru?.join(", "),
    gloss: [e.gloss],
    entry: e,
  };
}

export function phraseItem(p: PhraseItem): LearnItem {
  return { key: `p:${p.text}`, kind: "phrase", title: p.text, gloss: p.gloss };
}

/** Сөздүк + сүйлөмдөр → тректер (картадагы тартипте). */
export function buildTracks(signs: SignEntry[], phrases: PhraseItem[]): Track[] {
  const byTopic = new Map<string, SignEntry[]>();
  const mine: SignEntry[] = [];
  for (const s of signs) {
    if (s.source === "recorded" && !s.meta?.topic) mine.push(s);
    const t = s.meta?.topic;
    if (!t) continue;
    const list = byTopic.get(t);
    if (list) list.push(s);
    else byTopic.set(t, [s]);
  }
  const tracks: Track[] = [];
  const known = new Set(TOPICS.map(([t]) => t));
  const push = (topic: string, meta: TopicMeta) => {
    const list = byTopic.get(topic);
    if (!list?.length) return;
    list.sort((a, b) => lessonOf(a) - lessonOf(b) || orderId(a).localeCompare(orderId(b)));
    tracks.push({ id: `l${lessonOf(list[0])}`, title: meta.title, desc: meta.desc, emoji: meta.emoji, kind: "signs", core: Boolean(meta.core), items: list.map(signItem) });
  };
  for (const [topic, meta] of TOPICS) push(topic, meta);
  for (const topic of byTopic.keys()) if (!known.has(topic)) push(topic, { title: TOPIC_KY[topic] ?? topic, desc: "", emoji: "✳️" });

  const seen = new Set<string>();
  const ph = phrases.filter((p) => p.gloss.length > 0 && !seen.has(p.text) && seen.add(p.text)).map(phraseItem);
  if (ph.length) tracks.splice(Math.min(2, tracks.length), 0, { id: "phrases", title: "Даяр сүйлөмдөр", desc: "Бүтүн сүйлөмдү жест менен айтуу", emoji: "🗨️", kind: "phrases", core: true, items: ph });

  if (mine.length) tracks.push({ id: "mine", title: "Менин жесттерим", desc: "Студияда жаздырылгандар", emoji: "🎥", kind: "signs", core: false, items: mine.map(signItem) });
  return tracks;
}

/** Бардык тректердеги элементтер ачкыч боюнча (кайталоо трекин түзүү үчүн). */
export function indexItems(tracks: Track[]): Map<string, LearnItem> {
  const m = new Map<string, LearnItem>();
  for (const t of tracks) for (const it of t.items) if (!m.has(it.key)) m.set(it.key, it);
  return m;
}

export function shuffle<T>(a: T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
