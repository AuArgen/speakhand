// Сөз тандагыч: сөздүктөгү жесттер (китепкана + жаздырылган), тема боюнча, издөө менен. Басуу → долбоорго кошулат.
import { useMemo, useState } from "react";
import type { SignEntry } from "../../lib/types";
import { IconSearch } from "../icons";

const TOPIC_KY: Record<string, string> = {
  "Алфавит": "Алфавит",
  "Цифры": "Сандар",
  "Знакомство": "Таанышуу",
  "Человек": "Адам",
  "Родство, семья": "Үй-бүлө",
  "Дом": "Үй",
  "Домашние вещи": "Үй буюмдары",
  "Посуда, продукты": "Тамак-аш",
  "Растения": "Өсүмдүктөр",
  "Одежда, обувь": "Кийим",
  "Цвета": "Түстөр",
  "Время, календарь, времена года": "Убакыт",
  "Природа": "Жаратылыш",
  "В мире животных": "Жаныбарлар",
  "Спорт и отдых": "Спорт, эс алуу",
  "Город, транспорт": "Шаар, транспорт",
  "Школа": "Мектеп",
  "Путешествие": "Саякат",
  "Государство, страны мира": "Өлкөлөр",
  "Профессия, работа": "Кесип, иш",
  "Интеллектуальная деятельность": "Ой жүгүртүү",
  "Эмоции, чувства, состояние": "Сезимдер",
  "Медицина": "Медицина",
  "Право, закон": "Укук",
  "Религия": "Дин",
  "Антонимы": "Антонимдер",
  "Распространенные фразы": "Көп колдонулган",
  "Грамматика": "Грамматика",
};
const TOPIC_FIRST = ["Распространенные фразы", "Знакомство", "Эмоции, чувства, состояние", "Человек", "Родство, семья", "Время, календарь, времена года", "Посуда, продукты", "Медицина", "Город, транспорт"];

// Экспорттолбойт (Fast Refresh үчүн модулда компонент гана экспорттолот)
const wordLabel = (s: SignEntry) => s.aliases.find((a) => a && !/\d/.test(a)) ?? s.gloss.replace(/^#/, "").toLocaleLowerCase("ky-KG");

const PAGE = 72;

export function WordPicker(props: { signs: SignEntry[]; onPick: (s: SignEntry) => void; loading?: boolean }) {
  const [q, setQ] = useState("");
  const [topic, setTopic] = useState<string>("");
  const [limit, setLimit] = useState(PAGE);

  const topics = useMemo(() => {
    const set = new Set(props.signs.map((s) => s.meta?.topic).filter((t): t is string => Boolean(t)));
    const list = [...set];
    list.sort((a, b) => {
      const ia = TOPIC_FIRST.indexOf(a), ib = TOPIC_FIRST.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "ru");
    });
    return list;
  }, [props.signs]);

  const hasRecorded = props.signs.some((s) => s.source === "recorded");

  const list = useMemo(() => {
    const s = q.trim().toLocaleLowerCase("ky-KG");
    const out: SignEntry[] = [];
    for (const x of props.signs) {
      const letter = x.gloss.startsWith("#");
      if (topic === "recorded") { if (x.source !== "recorded") continue; }
      else if (topic) { if (x.meta?.topic !== topic) continue; }
      else if (letter && !s) continue; // тамгалар демейки тизмеде көрсөтүлбөйт
      if (s && !(x.gloss.toLocaleLowerCase("ky-KG").includes(s) || x.aliases.some((a) => a.includes(s)) || x.meta?.ru?.some((r) => r.toLocaleLowerCase("ru").includes(s)))) continue;
      out.push(x);
    }
    // Демейки тизме: күнүмдүк темалар алдыда, сандар/тамгалар аягында
    if (!s && !topic) {
      const rank = (x: SignEntry) => {
        const t = x.meta?.topic ?? "";
        if (x.source === "recorded") return -1;
        if (t === "Алфавит") return 99;
        if (t === "Цифры") return 90;
        const i = TOPIC_FIRST.indexOf(t);
        return i < 0 ? 50 : i;
      };
      out.sort((a, b) => rank(a) - rank(b) || wordLabel(a).localeCompare(wordLabel(b), "ky"));
    }
    return out;
  }, [props.signs, q, topic]);

  const shown = list.slice(0, limit);

  return (
    <div className="qp wp">
      <label className="qp-search">
        <IconSearch />
        <input type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Сөз издөө… (кыргызча же орусча)" aria-label="Сөз издөө" enterKeyHint="search" />
      </label>
      <div className="qp-groups" role="tablist" aria-label="Темалар">
        <button role="tab" aria-selected={!topic} className="qp-group" onClick={() => { setTopic(""); setLimit(PAGE); }}>✦ Баары</button>
        {hasRecorded && <button role="tab" aria-selected={topic === "recorded"} className="qp-group" onClick={() => { setTopic("recorded"); setLimit(PAGE); }}>🎥 Жаздырылган</button>}
        {topics.map((t) => (
          <button key={t} role="tab" aria-selected={topic === t} className="qp-group" onClick={() => { setTopic(t); setLimit(PAGE); }}>{TOPIC_KY[t] ?? t}</button>
        ))}
      </div>
      <div className="wp-grid" role="list">
        {props.loading && !props.signs.length && <div className="muted" style={{ padding: 12 }}><span className="spinner" style={{ verticalAlign: -3, marginRight: 8 }} /> Сөздүк жүктөлүүдө…</div>}
        {!props.loading && !shown.length && <div className="muted" style={{ padding: 12 }}>Табылган жок</div>}
        {shown.map((s) => (
          <button key={s.gloss} role="listitem" className="wp-item" onClick={() => props.onPick(s)} title={s.meta?.ru?.join(", ")}>
            <span className="wp-word">{wordLabel(s)}</span>
            <span className="wp-gloss">{s.gloss}</span>
          </button>
        ))}
      </div>
      {list.length > shown.length && (
        <button className="btn btn-sm" style={{ alignSelf: "center" }} onClick={() => setLimit((l) => l + PAGE)}>Дагы {Math.min(PAGE, list.length - shown.length)} сөз</button>
      )}
    </div>
  );
}
