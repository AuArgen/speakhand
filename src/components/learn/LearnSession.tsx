// Үйрөнүү картасы: бир жест (же бир сүйлөм) — аватар кайра-кайра көрсөтөт; «Кайталаңыз» — камера жанаша.
// Кийинки/мурунку: баскычтар, клавиатура жебелери, телефондо сүрүү (swipe).
import { useCallback, useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { learnHash, navigate } from "../../hooks/useHashRoute";
import { useRecognizer } from "../../lib/recognizer";
import { useStored } from "../../lib/settings";
import type { SignEntry } from "../../lib/types";
import { IconHand } from "../icons";
import { IconCheck, IconEye } from "../room/roomIcons";
import type { Track } from "./course";
import { IconLeft, IconRight } from "./learnIcons";
import { PracticeBox } from "./Practice";
import { LEVEL_LABEL, levelOf, markSeen, recordAnswer, setPosition, useLearnState } from "./progress";
import { SignPlayer, type Speed } from "./SignPlayer";

export function LearnSession(props: {
  track: Track;
  index: number;
  theme: "dark" | "light";
  signs: SignEntry[];
  labelOf: (gloss: string) => string;
}) {
  const { track } = props;
  const n = track.items.length;
  const idx = Math.max(0, Math.min(n - 1, props.index));
  const item = track.items[idx];
  const st = useLearnState();
  const [speed, setSpeed] = useStored<Speed>("learnSpeed", 1);
  const [loop, setLoop] = useState(true);
  const [mode, setMode] = useStored<"watch" | "practice">("learnMode", "watch");
  const [cameraOn, setCameraOn] = useState(false);
  const [active, setActive] = useState(-1);
  /** Сүйлөмдөгү тандалган жест (null — бүт сүйлөм) */
  const [focus, setFocus] = useState<number | null>(null);
  const practice = mode === "practice";
  const recognizer = useRecognizer(practice);

  const go = useCallback((i: number) => {
    if (i < 0 || i >= n) return;
    navigate(learnHash(track.id, "learn", i));
  }, [n, track.id]);

  // Карта алмашканда
  useEffect(() => {
    setFocus(null);
    setActive(-1);
    setPosition(track.id, idx);
    const t = window.setTimeout(() => markSeen(item.key), 1500);
    return () => window.clearTimeout(t);
  }, [track.id, idx, item.key]);

  // Клавиатура: ← → (жазуу талаасында эмес)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, idx]);

  // Сүрүү (аватардын canvas'ы эмес — ал айлантууга керек)
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => {
    if ((e.target as HTMLElement).closest(".stage-canvas, .ln-cam, button, input")) { touch.current = null; return; }
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? idx + 1 : idx - 1);
  };

  const gloss = useMemo(() => (focus !== null ? [item.gloss[focus]] : item.gloss), [item, focus]);
  const level = levelOf(st, item.key);
  const isPhrase = item.kind === "phrase";

  const player = (
    <SignPlayer
      theme={props.theme}
      gloss={gloss}
      signs={props.signs}
      speed={speed}
      onSpeed={setSpeed}
      loop={loop}
      onLoop={setLoop}
      onActive={setActive}
      className={practice ? "compact" : ""}
    />
  );

  return (
    <div className="ln-session" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="ln-session-bar">
        <button className="btn btn-ghost btn-sm ln-back" onClick={() => navigate(learnHash(track.id))} aria-label={`${track.title} — темага кайтуу`}><IconLeft /> <span className="ln-back-t">{track.title}</span></button>
        <span className="ln-counter" aria-live="polite">{idx + 1} / {n}</span>
      </div>
      <div className="ln-progress" aria-hidden><i style={{ width: `${((idx + 1) / n) * 100}%` }} /></div>

      <div className={`ln-card ${practice ? "practice" : "watch"}`}>
        {!practice && <div className="ln-stage">{player}</div>}

        <div className="ln-word-block">
          <div className="ln-word-main">
            <h2 className={`ln-big ${isPhrase ? "phrase" : ""}`} lang="ky">{item.title}</h2>
            {item.ru && <p className="ln-ru" lang="ru">{item.ru}</p>}
          </div>
          <span className={`ln-level lv-${level}`}>{level === 3 && <IconCheck />} {LEVEL_LABEL[level]}</span>
        </div>

        {isPhrase && (
          <div className="ln-chips" role="group" aria-label="Сүйлөмдөгү жесттер">
            <button className={`ln-chip ${focus === null ? "on" : ""}`} onClick={() => setFocus(null)}>Бүт сүйлөм</button>
            {item.gloss.map((g, i) => {
              const on = focus === i;
              const playingNow = focus === null && active === i;
              return (
                <button key={`${g}-${i}`} className={`ln-chip ${on ? "on" : ""} ${playingNow ? "live" : ""}`} onClick={() => setFocus(i)} title={`Аватар «${props.labelOf(g)}» жестин гана көрсөтсүн`}>
                  {props.labelOf(g)}
                </button>
              );
            })}
          </div>
        )}

        <div className="ln-modes" role="tablist" aria-label="Режим">
          <button role="tab" aria-selected={!practice} onClick={() => { setMode("watch"); setCameraOn(false); }}><IconEye /> Көрүү</button>
          <button role="tab" aria-selected={practice} onClick={() => setMode("practice")}><IconHand /> Кайталаңыз</button>
        </div>

        {practice && (
          <PracticeBox
            target={item.gloss}
            recognizer={recognizer}
            labelOf={props.labelOf}
            cameraOn={cameraOn}
            setCameraOn={setCameraOn}
            side={player}
            hint={isPhrase ? "Аватарды карап, бүт сүйлөмдү кайталаңыз. Бүткөндө эки колуңузду түшүрүңүз." : "Аватарды карап, жестти кайталаңыз. Бүткөндө эки колуңузду түшүрүңүз."}
            onResult={(r) => { if (r.check.ok) recordAnswer(item.key, true); }}
          />
        )}
      </div>

      <nav className="ln-nav" aria-label="Карталар">
        <button className="btn btn-lg ln-nav-prev" onClick={() => go(idx - 1)} disabled={idx === 0} aria-label="Мурунку"><IconLeft /></button>
        {idx < n - 1 ? (
          <button className="btn btn-primary btn-lg ln-nav-next" onClick={() => { markSeen(item.key); go(idx + 1); }}>
            {level >= 1 ? "Кийинки" : "Үйрөндүм — кийинки"} <IconRight />
          </button>
        ) : (
          <button className="btn btn-primary btn-lg ln-nav-next" onClick={() => { markSeen(item.key); navigate(learnHash(track.id, "quiz")); }}>
            Бүттү — өзүмдү текшерем <IconRight />
          </button>
        )}
      </nav>
      <p className="ln-kbd muted hide-sm">← → — мурунку / кийинки</p>
    </div>
  );
}

