// Жест сөздүгү: издөө, көрүү, өчүрүү, экспорт/импорт.
import { useMemo, useRef, useState } from "react";
import { AvatarView, type AvatarHandle } from "../components/AvatarView";
import { IconDownload, IconPlay, IconRecord, IconSearch, IconTrash, IconUpload } from "../components/icons";
import { resolveClip } from "../data/library";
import { deleteSign, exportDictionary, importDictionary } from "../data/store";
import type { SignEntry } from "../lib/types";
import { useDictionary } from "../lib/useDictionary";

const SOURCE_LABEL: Record<SignEntry["source"], string> = {
  library: "Видео (РЖЯ)",
  recorded: "Жаздырылган",
  demo: "Демо",
};

export function DictionaryPage(props: { theme: "dark" | "light"; openStudio: (gloss: string) => void; toast: (m: string) => void }) {
  const { signs, loading } = useDictionary();
  const avatar = useRef<AvatarHandle>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | SignEntry["source"]>("all");
  const [topic, setTopic] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const s = q.trim().toLocaleLowerCase("ky-KG");
    return signs.filter(
      (x) =>
        (filter === "all" || x.source === filter) &&
        (!topic || x.meta?.topic === topic) &&
        (!s ||
          x.gloss.toLocaleLowerCase("ky-KG").includes(s) ||
          x.aliases.some((a) => a.includes(s)) ||
          x.meta?.ru?.some((r) => r.toLocaleLowerCase("ru").includes(s))),
    );
  }, [signs, q, filter, topic]);
  const topics = useMemo(() => [...new Set(signs.map((s) => s.meta?.topic).filter((t): t is string => Boolean(t)))], [signs]);

  const sel = signs.find((s) => s.gloss === selected) ?? null;
  const recorded = signs.filter((s) => s.source === "recorded").length;
  const library = signs.filter((s) => s.source === "library").length;
  // Китепкана жесттери таанууга алдын ала эсептелген үлгүлөр (templates.bin) менен даяр.
  const trained = signs.filter((s) => s.samples.length > 0 || s.source === "library").length;
  const showSeq = useRef(0);

  async function show(s: SignEntry) {
    setSelected(s.gloss);
    avatar.current?.stop();
    const my = ++showSeq.current;
    const t0 = performance.now();
    const clip = await resolveClip(s);
    if (my !== showSeq.current) return; // колдонуучу башкасын тандап үлгүрдү
    if (s.clipUrl && !s.clip) console.debug(`[dictionary] ${s.gloss}: клип ${Math.round(performance.now() - t0)} мс`);
    avatar.current?.play([{ gloss: s.gloss, clip }]);
  }

  async function doExport() {
    const blob = await exportDictionary();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `suylo-sozduk-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function doImport(f: File) {
    try {
      const n = await importDictionary(f);
      props.toast(`${n} жест импорттолду`);
    } catch (e) {
      props.toast(`Импорт катасы: ${(e as Error).message}`);
    }
  }

  return (
    <div className="grid-2">
      <div>
        <div className="page-intro">
          <h1>Жест сөздүгү</h1>
          <p>{signs.length} жест · {library} видеосабактан · {recorded} Студияда жаздырылган · {trained} таанууга даяр. Сөздүктү JSON катары экспорттоп, башка компьютерге же командага бөлүшө аласыз.</p>
        </div>
        <div className="toolbar">
          <div style={{ position: "relative" }}>
            <IconSearch style={{ position: "absolute", left: 12, top: 12, width: 18, color: "var(--text-3)" }} />
            <input className="input" style={{ paddingLeft: 38 }} placeholder="Издөө…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="seg">
            {(["all", "library", "recorded", "demo"] as const).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "Баары" : SOURCE_LABEL[f]}
              </button>
            ))}
          </div>
          {topics.length > 0 && (
            <select className="select" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Тема">
              <option value="">Бардык темалар</option>
              {topics.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <div className="spacer" />
          <button className="btn btn-sm" onClick={doExport}><IconDownload /> Экспорт</button>
          <button className="btn btn-sm" onClick={() => file.current?.click()}><IconUpload /> Импорт</button>
          <input ref={file} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        </div>

        {loading ? (
          <div className="empty"><span className="spinner" /></div>
        ) : list.length ? (
          <div className="dict-grid">
            {list.map((s) => (
              <button key={s.gloss} className={`sign-card ${selected === s.gloss ? "selected" : ""}`} onClick={() => show(s)}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <h3>{s.gloss}</h3>
                  <IconPlay style={{ width: 16, color: "var(--text-3)" }} />
                </div>
                <div className="aliases">{s.meta?.ru ? `РЖЯ: ${s.meta.ru.join(", ")}` : s.aliases.join(", ") || "—"}</div>
                <div className="row">
                  <span className={`chip ${s.source === "demo" ? "demo" : "rec"}`}>{SOURCE_LABEL[s.source]}</span>
                  {s.source === "library" ? (
                    <span className="chip">{s.meta?.ids?.length ?? 1} вариант</span>
                  ) : (
                    <span className="chip">{s.samples.length} мисал</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty"><strong>Эч нерсе табылган жок</strong>Жаңы жестти Студияда жаздырыңыз.</div>
        )}
      </div>

      <div className="stack sticky">
        <AvatarView ref={avatar} theme={props.theme}>
          <div className="stage-overlay">
            <div className="stage-top"><span className="chip">Көрүү</span></div>
            <div className={`caption ${sel ? "" : "hidden"}`}>{sel?.gloss}</div>
          </div>
        </AvatarView>
        {sel && (
          <div className="card card-pad">
            <div className="card-head">
              <h2 className="card-title">{sel.gloss}</h2>
              <span className={`chip ${sel.source === "demo" ? "demo" : "rec"}`}>
                {sel.source === "demo" ? "Текшерилбеген демо" : sel.source === "library" ? "Видеосабактан (РЖЯ)" : "Студияда жаздырылган"}
              </span>
            </div>
            {sel.meta && (
              <p className="muted" style={{ marginTop: 0 }}>
                Орусча: {sel.meta.ru?.join(", ")} · {sel.meta.lesson}-сабак, «{sel.meta.topic}»
                <br />
                Сөз формалары: {sel.aliases.join(", ")}
              </p>
            )}
            <div className="row">
              <button className="btn btn-sm" onClick={() => show(sel)}><IconPlay /> Кайра</button>
              <button className="btn btn-sm" onClick={() => props.openStudio(sel.gloss)}><IconRecord /> {sel.source === "demo" ? "Чыныгысын жаздыруу" : "Мисал кошуу"}</button>
              <div className="spacer" />
              {/* Видео китепкана статикалык (өчүрүлбөйт); өчүрүү — IndexedDB'деги жазуу үчүн гана */}
              {sel.source !== "library" && <button
                className="btn btn-sm btn-ghost btn-danger"
                onClick={async () => {
                  if (!confirm(`«${sel.gloss}» өчүрүлсүнбү?`)) return;
                  await deleteSign(sel.gloss);
                  setSelected(null);
                }}
              >
                <IconTrash /> Өчүрүү
              </button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
