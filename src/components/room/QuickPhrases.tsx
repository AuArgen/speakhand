// Даяр сүйлөмдөр: издөө + темалар + бир басуу менен жөнөтүү. AI жок — дароо.
import { useMemo, useState } from "react";
import type { PhraseItem } from "../../lib/room";
import { IconSearch } from "../icons";
import { GROUP_OTHER, PHRASE_GROUPS, groupOf, matchPhrase } from "./phraseGroups";

export function QuickPhrases(props: { phrases: PhraseItem[]; recent: string[]; onPick: (p: PhraseItem) => void; loading?: boolean; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string>(props.recent.length ? "recent" : "all");

  const grouped = useMemo(() => {
    const m = new Map<string, PhraseItem[]>();
    for (const p of props.phrases) {
      const g = groupOf(p);
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(p);
    }
    return m;
  }, [props.phrases]);

  const byText = useMemo(() => new Map(props.phrases.map((p) => [p.text, p])), [props.phrases]);
  const recentItems = props.recent.map((t) => byText.get(t)).filter((p): p is PhraseItem => Boolean(p));

  const list = useMemo(() => {
    const searching = q.trim().length > 0;
    let base: PhraseItem[];
    if (searching || group === "all") base = props.phrases;
    else if (group === "recent") base = recentItems;
    else base = grouped.get(group) ?? [];
    return base.filter((p) => matchPhrase(p, q));
  }, [q, group, props.phrases, grouped, recentItems]);

  const groups = [
    ...(recentItems.length ? [{ id: "recent", label: "Акыркы", emoji: "🕘" }] : []),
    { id: "all", label: "Баары", emoji: "✦" },
    ...PHRASE_GROUPS.filter((g) => grouped.has(g.id)),
    ...(grouped.has(GROUP_OTHER.id) ? [GROUP_OTHER] : []),
  ];

  return (
    <div className="qp">
      <label className="qp-search">
        <IconSearch />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Сүйлөм издөө…"
          aria-label="Даяр сүйлөм издөө"
          autoFocus={props.autoFocus}
          enterKeyHint="search"
        />
      </label>
      <div className="qp-groups" role="tablist" aria-label="Темалар">
        {groups.map((g) => (
          <button key={g.id} role="tab" aria-selected={group === g.id && !q} className="qp-group" onClick={() => { setGroup(g.id); setQ(""); }}>
            <span aria-hidden>{g.emoji}</span> {g.label}
          </button>
        ))}
      </div>
      <div className="qp-list" role="list">
        {props.loading && !props.phrases.length && <div className="muted" style={{ padding: 12 }}><span className="spinner" style={{ verticalAlign: -3, marginRight: 8 }} /> Сүйлөмдөр жүктөлүүдө…</div>}
        {!props.loading && !list.length && <div className="muted" style={{ padding: 12 }}>Табылган жок</div>}
        {list.map((p) => (
          <button key={p.text} role="listitem" className={`qp-item ${p.question ? "q" : ""}`} onClick={() => props.onPick(p)}>
            <span className="qp-text">{p.text}</span>
            <span className="qp-gloss">{p.gloss.join(" · ")}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
