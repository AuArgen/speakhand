// Даяр сүйлөмдөрдү темаларга бөлүү (AI'сыз, ачкыч сөздөр боюнча) жана акыркы колдонулгандар.
import type { PhraseItem } from "../../lib/room";

export interface PhraseGroup {
  id: string;
  label: string;
  emoji: string;
  test: RegExp;
}

export const PHRASE_GROUPS: PhraseGroup[] = [
  { id: "help", label: "Жардам", emoji: "🆘", test: /жардам|оору|доктур|дарыгер|оорукана|дары|милиция|полиция|өрт|коркунуч|адаш|тез/i },
  { id: "hello", label: "Саламдашуу", emoji: "👋", test: /салам|кайырлы|кош бол|жакшы кал|көрүшкөнчө|көрүшөбүз|рахмат|эч нерсе эмес|кечир|сураныч/i },
  { id: "understand", label: "Түшүнүшүү", emoji: "💬", test: /уга албайм|угпайм|жаңсоо|жест|жайыраак|кайра айт|түшүн|жазып бер|кайталап/i },
  { id: "needs", label: "Керектөө", emoji: "🥣", test: /суу|ачка|тамак|даараткана|канча турат|керек|чарча|эс ал|үйгө бар|ичким|жегим/i },
  { id: "time", label: "Убакыт", emoji: "🕒", test: /бүгүн|эртең|кечээ|азыр|саат|качан|күтө|келем|келесиз/i },
  { id: "meet", label: "Таанышуу", emoji: "🙂", test: /атым|атыңыз|атың|таанышканыма|менмин|кайдансыз|студент|мугалиммин|жумушчу|жашта/i },
  { id: "family", label: "Үй-бүлө", emoji: "👨‍👩‍👧", test: /үй-бүлө|апам|атам|агам|эжем|иним|досум|балдар|үйдө|жумушта/i },
  { id: "study", label: "Окуу, иш", emoji: "📚", test: /мектеп|окуй|сабак|мугалим|тапшырма|китеп|жумуш/i },
  { id: "feel", label: "Сезим, жооп", emoji: "💛", test: /кубаныч|капа|ооба|жок|макул|жакшы|жаман|сүйөм|каалайм/i },
];

export const GROUP_OTHER: PhraseGroup = { id: "other", label: "Башка", emoji: "•", test: /./ };

export function groupOf(p: PhraseItem): string {
  return PHRASE_GROUPS.find((g) => g.test.test(p.text))?.id ?? GROUP_OTHER.id;
}

const RECENT_KEY = "speak:recentPhrases";

export function loadRecentPhrases(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecentPhrase(text: string): string[] {
  const list = [text, ...loadRecentPhrases().filter((t) => t !== text)].slice(0, 10);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* жеке режим */
  }
  return list;
}

/** Издөө: кичине тамгага салып, камтылганын текшерет */
export function matchPhrase(p: PhraseItem, q: string): boolean {
  const s = q.trim().toLocaleLowerCase("ky-KG");
  if (!s) return true;
  return p.text.toLocaleLowerCase("ky-KG").includes(s) || p.gloss.some((g) => g.toLocaleLowerCase("ky-KG").includes(s));
}
