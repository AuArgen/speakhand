// Курстун картасы: темалар (карталар, прогресс айланасы), даяр сүйлөмдөр, катар күндөр, бүгүнкү максат.
import { navigate, learnHash } from "../../hooks/useHashRoute";
import { IconArrow } from "../icons";
import type { Track } from "./course";
import { IconFlame, IconTarget } from "./learnIcons";
import { DAILY_GOAL, statsOf, streakOf, todayCount, useLearnState } from "./progress";
import { Ring } from "./Ring";

export function CourseMap(props: { tracks: Track[]; review: Track | null; loading: boolean }) {
  const st = useLearnState();
  const streak = streakOf(st);
  const today = todayCount(st);
  const last = st.last ? props.tracks.find((t) => t.id === st.last) : undefined;
  const core = props.tracks.filter((t) => t.core);
  const rest = props.tracks.filter((t) => !t.core);
  const mastered = Object.values(st.items).filter((i) => i.l >= 3).length;

  return (
    <div className="ln-map">
      <section className="ln-hero">
        <div>
          <h1>Жест тилин үйрөнүү</h1>
          <p>Аватар көрсөтөт — сиз кайталайсыз, камера текшерет. Күнүнө 10 жест — бир айда 300.</p>
        </div>
        <div className="ln-hero-stats">
          <div className={`ln-stat ${streak ? "hot" : ""}`} title="Катары менен үйрөнгөн күндөр">
            <IconFlame />
            <b>{streak}</b>
            <small>күн катары</small>
          </div>
          <div className="ln-stat" title={`Бүгүнкү максат: ${DAILY_GOAL} жест`}>
            <Ring value={today / DAILY_GOAL} size={34} stroke={4} tone={today >= DAILY_GOAL ? "ok" : "accent"} label={`Бүгүн ${today}/${DAILY_GOAL}`}>
              <IconTarget style={{ width: 14, height: 14 }} />
            </Ring>
            <b>{Math.min(today, 99)}/{DAILY_GOAL}</b>
            <small>бүгүн</small>
          </div>
          <div className="ln-stat" title="Өздөштүрүлгөн жесттер">
            <span className="ln-stat-emoji" aria-hidden>🏅</span>
            <b>{mastered}</b>
            <small>өздөштүрүлдү</small>
          </div>
        </div>
      </section>

      {(last || props.review) && (
        <div className="ln-continue-row">
          {last && <ContinueCard track={last} index={st.pos[last.id] ?? 0} />}
          {props.review && (
            <button className="ln-continue review" onClick={() => navigate(learnHash("review"))}>
              <span className="ln-emoji" aria-hidden>🔁</span>
              <span className="ln-continue-text"><small>Каталарды кайталоо</small><b>{props.review.items.length} жест кайра көрүүнү күтөт</b></span>
              <IconArrow className="ln-continue-arrow" />
            </button>
          )}
        </div>
      )}

      {props.loading && !props.tracks.length && (
        <div className="ln-tracks">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="ln-track skeleton" aria-hidden />)}
        </div>
      )}

      {core.length > 0 && (
        <section className="ln-section">
          <h2 className="card-title">Башталыш — эң керектүүлөр</h2>
          <div className="ln-tracks">
            {core.map((t) => <TrackCard key={t.id} track={t} />)}
          </div>
        </section>
      )}
      {rest.length > 0 && (
        <section className="ln-section">
          <h2 className="card-title">Дагы темалар</h2>
          <div className="ln-tracks">
            {rest.map((t) => <TrackCard key={t.id} track={t} />)}
          </div>
        </section>
      )}
      <p className="muted ln-foot">Жесттер — видеосабактардан алынган орус жест тилинин (РЖЯ) жесттери, Кыргызстанда да колдонулат. Прогресс ушул браузерде гана сакталат.</p>
    </div>
  );
}

function TrackCard({ track }: { track: Track }) {
  const st = useLearnState();
  const s = statsOf(st, track.items.map((i) => i.key));
  const unit = track.kind === "phrases" ? "сүйлөм" : "жест";
  return (
    <button className={`ln-track ${track.kind === "phrases" ? "phrases" : ""}`} onClick={() => navigate(learnHash(track.id))}>
      <span className="ln-emoji" aria-hidden>{track.emoji}</span>
      <span className="ln-track-text">
        <b>{track.title}</b>
        <small>{track.items.length} {unit}{s.seen ? ` · ${s.seen} үйрөнүлдү` : ""}</small>
      </span>
      <Ring value={s.ratio} size={38} stroke={4} tone={s.mastered === s.total && s.total ? "ok" : "accent"} label={`${Math.round(s.ratio * 100)}% өздөштүрүлдү`}>
        <span className="ln-ring-pct">{Math.round(s.ratio * 100)}</span>
      </Ring>
    </button>
  );
}

function ContinueCard({ track, index }: { track: Track; index: number }) {
  const i = Math.min(index, track.items.length - 1);
  return (
    <button className="ln-continue" onClick={() => navigate(learnHash(track.id, "learn", i))}>
      <span className="ln-emoji" aria-hidden>{track.emoji}</span>
      <span className="ln-continue-text"><small>Улантуу · {track.title}</small><b>{track.items[i]?.title ?? ""} <span className="muted">({i + 1}/{track.items.length})</span></b></span>
      <IconArrow className="ln-continue-arrow" />
    </button>
  );
}
