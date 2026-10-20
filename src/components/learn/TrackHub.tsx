// Тема барагы: прогресс, үч аракет (үйрөнүү / бул кайсы жест? / көрсөтүңүз) жана бардык сөздөр.
import { useState } from "react";
import { learnHash, navigate } from "../../hooks/useHashRoute";
import { IconHand } from "../icons";
import type { Track } from "./course";
import { IconGrad, IconLeft, IconQuestion } from "./learnIcons";
import { LEVEL_LABEL, MASTER_N, levelOf, statsOf, useLearnState } from "./progress";
import { Ring } from "./Ring";

const PAGE = 60;

export function TrackHub({ track }: { track: Track }) {
  const st = useLearnState();
  const s = statsOf(st, track.items.map((i) => i.key));
  const pos = Math.min(st.pos[track.id] ?? 0, track.items.length - 1);
  const [limit, setLimit] = useState(PAGE);
  const unit = track.kind === "phrases" ? "сүйлөм" : "жест";
  const firstNew = track.items.findIndex((i) => levelOf(st, i.key) === 0);
  const startAt = st.pos[track.id] !== undefined ? pos : Math.max(0, firstNew);

  return (
    <div className="ln-hub">
      <button className="btn btn-ghost btn-sm ln-back" onClick={() => navigate(learnHash())}><IconLeft /> Бардык темалар</button>
      <header className="ln-hub-head">
        <span className="ln-emoji big" aria-hidden>{track.emoji}</span>
        <div className="ln-hub-title">
          <h1>{track.title}</h1>
          <p className="muted">{track.items.length} {unit}{track.desc ? ` · ${track.desc}` : ""}</p>
        </div>
        <Ring value={s.ratio} size={58} stroke={5} tone={s.total && s.mastered === s.total ? "ok" : "accent"} label={`${Math.round(s.ratio * 100)}%`}>
          <span className="ln-ring-pct big">{Math.round(s.ratio * 100)}%</span>
        </Ring>
      </header>

      <div className="ln-levels" aria-label="Прогресс">
        <span><i className="lv lv1" /> {s.seen} үйрөнүлдү</span>
        <span><i className="lv lv2" /> {s.practiced} машыгылды</span>
        <span><i className="lv lv3" /> {s.mastered} өздөштүрүлдү</span>
      </div>

      <div className="ln-hub-actions">
        <button className="big-action primary" onClick={() => navigate(learnHash(track.id, "learn", startAt))}>
          <span className="big-action-icon"><IconGrad /></span>
          <span className="big-action-text"><b>{s.seen ? "Үйрөнүүнү улантуу" : "Үйрөнүүнү баштоо"}</b><small>Аватар көрсөтөт · камера менен кайталаңыз</small></span>
        </button>
        <button className="big-action" onClick={() => navigate(learnHash(track.id, "quiz"))}>
          <span className="big-action-icon"><IconQuestion /></span>
          <span className="big-action-text"><b>Бул кайсы жест?</b><small>10 суроо · 4 жооптон тандаңыз · камерасыз</small></span>
        </button>
        <button className="big-action" onClick={() => navigate(learnHash(track.id, "show"))}>
          <span className="big-action-icon"><IconHand /></span>
          <span className="big-action-text"><b>Көрсөтүңүз</b><small>Сөз чыгат — сиз жаңсайсыз, камера баалайт</small></span>
        </button>
      </div>
      <p className="muted ln-hub-note">Тестте {MASTER_N} жолу катары менен туура жооп берсеңиз — жест «өздөштүрүлдү» болот.</p>

      <section className="ln-section">
        <h2 className="card-title">Бардык {track.kind === "phrases" ? "сүйлөмдөр" : "жесттер"}</h2>
        <div className={`ln-words ${track.kind}`}>
          {track.items.slice(0, limit).map((it, i) => {
            const l = levelOf(st, it.key);
            return (
              <button key={it.key} className="ln-word" onClick={() => navigate(learnHash(track.id, "learn", i))} title={`${it.ru ?? it.gloss.join(" ")} — ${LEVEL_LABEL[l]}`}>
                <i className={`lv lv${l}`} aria-label={LEVEL_LABEL[l]} />
                <span className="ln-word-t">{it.title}</span>
                {it.ru && <span className="ln-word-ru">{it.ru}</span>}
              </button>
            );
          })}
        </div>
        {track.items.length > limit && (
          <button className="btn btn-sm" style={{ alignSelf: "center" }} onClick={() => setLimit((l) => l + PAGE)}>Дагы {Math.min(PAGE, track.items.length - limit)}</button>
        )}
      </section>
    </div>
  );
}
