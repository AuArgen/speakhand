// «Текшерүү»: (a) «Бул кайсы жест?» — аватар көрсөтөт, 4 жооптон тандайсыз (камерасыз);
// (b) «Көрсөтүңүз» — сөз чыгат, сиз жаңсайсыз, камера checkSign менен баалайт. Раунд — 10 суроо.
import { useCallback, useEffect, useRef, useState } from "react";
import { learnHash, navigate } from "../../hooks/useHashRoute";
import { vibrate } from "../../hooks/useHaptics";
import { useRecognizer } from "../../lib/recognizer";
import { useStored } from "../../lib/settings";
import type { SignEntry } from "../../lib/types";
import { IconX } from "../icons";
import { IconCheck, IconEye, IconSkip } from "../room/roomIcons";
import { shuffle, type LearnItem, type Track } from "./course";
import { IconLeft, IconRight, IconTrophy } from "./learnIcons";
import { PracticeBox } from "./Practice";
import { MASTER_N, recordAnswer, useLearnState, type LearnState } from "./progress";
import { Ring } from "./Ring";
import { SignPlayer, type Speed } from "./SignPlayer";

const ROUND = 10;
const MAX_TRIES = 3;

interface Answer { item: LearnItem; ok: boolean; mastered: boolean }
interface Question { item: LearnItem; options: LearnItem[] }

/** Раундга элементтер: каталар → үйрөнүлгөндөр → жаңылар → өздөштүрүлгөндөр (ар топтун ичинде аралаш). */
function pickRound(items: LearnItem[], st: LearnState, n = ROUND): LearnItem[] {
  const rank = (it: LearnItem) => {
    const p = st.items[it.key];
    if (!p) return 2;
    if (p.miss) return 0;
    if (p.l === 3) return 3;
    return 1;
  };
  const groups: LearnItem[][] = [[], [], [], []];
  for (const it of items) groups[rank(it)].push(it);
  return shuffle(groups.flatMap((g) => shuffle(g)).slice(0, n));
}

function optionsFor(item: LearnItem, pool: LearnItem[], fallback: LearnItem[]): LearnItem[] {
  const seen = new Set([item.title]);
  const out: LearnItem[] = [item];
  for (const src of [shuffle(pool), shuffle(fallback)]) {
    for (const it of src) {
      if (out.length >= 4) break;
      if (seen.has(it.title) || it.kind !== item.kind) continue;
      seen.add(it.title);
      out.push(it);
    }
  }
  return shuffle(out);
}

export function Quiz(props: {
  track: Track;
  mode: "pick" | "show";
  theme: "dark" | "light";
  signs: SignEntry[];
  /** Бардык элементтер — тректе жооп варианттары жетпесе */
  all: LearnItem[];
  labelOf: (gloss: string) => string;
}) {
  const { track, mode } = props;
  const st = useLearnState();
  const recognizer = useRecognizer(mode === "show");
  const [nonce, setNonce] = useState(0);
  const all = props.all;
  const [cameraOn, setCameraOn] = useState(false);
  // checkSign / checkSequence максатты ар дайым салыштырууга кошот — бардык элементтер жарайт
  // (сүйлөм «Көрсөтүңүз» режиминде бүтүн, бир айтылыш менен текшерилет)
  const pool = track.items;

  // Раунд бир жолу түзүлөт (st'нин кийинки өзгөрүүлөрү раундду алмаштырбайт)
  const stRef = useRef(st);
  stRef.current = st;
  const make = useCallback(
    (): Question[] => pickRound(pool, stRef.current).map((item) => ({ item, options: mode === "pick" ? optionsFor(item, track.items, all) : [] })),
    [pool, mode, track.items, all],
  );
  const [round, setRound] = useState<Question[]>(make);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const started = useRef(false);
  started.current = answers.length > 0 || i > 0;
  const done = i >= round.length && round.length > 0;

  // Тандоо тизмеси өзгөрсө (мис. таануу сөздүгү жүктөлдү) — раунд башталбаса гана жаңыртабыз
  useEffect(() => {
    if (!started.current) setRound(make());
  }, [make]);

  const answer = useCallback((item: LearnItem, ok: boolean) => {
    const level = recordAnswer(item.key, ok);
    setAnswers((a) => [...a, { item, ok, mastered: level === 3 }]);
    vibrate(ok ? 20 : [40, 40, 40]);
  }, []);

  const exit = () => navigate(learnHash(track.id));
  const restart = () => {
    setRound(make());
    setI(0);
    setAnswers([]);
    setNonce((x) => x + 1);
  };

  if (!round.length) {
    return (
      <div className="ln-quiz">
        <QuizBar track={track} i={0} n={0} correct={0} onExit={exit} title={mode === "pick" ? "Бул кайсы жест?" : "Көрсөтүңүз"} />
        <div className="empty"><strong>Бул темада суроо жок</strong>Башка теманы тандаңыз.</div>
      </div>
    );
  }

  if (done) return <Summary track={track} mode={mode} answers={answers} onAgain={restart} onExit={exit} />;

  const { item, options } = round[i];
  const correct = answers.filter((a) => a.ok).length;
  const next = () => setI((x) => x + 1);

  return (
    <div className="ln-quiz">
      <QuizBar track={track} i={i} n={round.length} correct={correct} onExit={exit} title={mode === "pick" ? "Бул кайсы жест?" : "Көрсөтүңүз"} />
      {mode === "pick" ? (
        <PickQuestion key={`${nonce}-${i}`} item={item} options={options} theme={props.theme} signs={props.signs} onAnswer={answer} onNext={next} />
      ) : (
        <ShowQuestion key={`${nonce}-${i}`} item={item} theme={props.theme} signs={props.signs} recognizer={recognizer} labelOf={props.labelOf} onAnswer={answer} onNext={next} trackId={track.id} cameraOn={cameraOn} setCameraOn={setCameraOn} />
      )}
    </div>
  );
}

function QuizBar(props: { track: Track; i: number; n: number; correct: number; onExit: () => void; title: string }) {
  return (
    <>
      <div className="ln-session-bar">
        <button className="btn btn-ghost btn-sm ln-back" onClick={props.onExit} aria-label="Тестти токтотуу"><IconX /> <span className="ln-back-t">{props.track.title}</span></button>
        <span className="ln-quiz-title">{props.title}</span>
        <span className="ln-counter" aria-live="polite">{Math.min(props.i + 1, props.n)} / {props.n}</span>
      </div>
      <div className="ln-progress" aria-hidden><i style={{ width: `${props.n ? (props.i / props.n) * 100 : 0}%` }} /></div>
    </>
  );
}

// ───────────────────────── (a) Бул кайсы жест? ─────────────────────────

function PickQuestion(props: {
  item: LearnItem;
  options: LearnItem[];
  theme: "dark" | "light";
  signs: SignEntry[];
  onAnswer: (item: LearnItem, ok: boolean) => void;
  onNext: () => void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const [speed, setSpeed] = useStored<Speed>("learnSpeed", 1);
  const { item, options } = props;
  const right = options.findIndex((o) => o.key === item.key);
  const answered = chosen !== null;
  const ok = chosen === right;
  const nextBtn = useRef<HTMLButtonElement>(null);
  const onNext = useRef(props.onNext);
  onNext.current = props.onNext;

  const choose = useCallback((k: number) => {
    if (chosen !== null) return;
    setChosen(k);
    props.onAnswer(item, k === right);
  }, [chosen, item, right, props]);

  // Туура болсо — бир аздан кийин кийинкиге; ката болсо — колдонуучу өзү басат
  useEffect(() => {
    if (!answered) return;
    if (ok) {
      const t = window.setTimeout(() => onNext.current(), 1200);
      return () => window.clearTimeout(t);
    }
    nextBtn.current?.focus();
  }, [answered, ok]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const k = Number(e.key);
      if (k >= 1 && k <= options.length) { e.preventDefault(); choose(k - 1); }
      else if ((e.key === "Enter" || e.key === "ArrowRight") && answered) { e.preventDefault(); onNext.current(); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [choose, answered, options.length]);

  const phrase = item.kind === "phrase";

  return (
    <div className="ln-q">
      <div className="ln-stage quiz">
        <SignPlayer theme={props.theme} gloss={item.gloss} signs={props.signs} speed={speed} onSpeed={setSpeed} />
      </div>
      <p className="ln-q-prompt">{answered ? (ok ? "✓ Туура!" : <>Туурасы: <b>{item.title}</b></>) : phrase ? "Аватар кайсы сүйлөмдү айтты?" : "Аватар кайсы сөздү көрсөттү?"}</p>
      <div className={`ln-options ${phrase ? "phrase" : ""}`} role="group" aria-label="Жооптор">
        {options.map((o, k) => {
          const state = !answered ? "" : k === right ? "right" : k === chosen ? "wrong" : "dim";
          return (
            <button key={o.key} className={`ln-option ${state}`} onClick={() => choose(k)} disabled={answered && k !== right && k !== chosen} aria-pressed={chosen === k}>
              <span className="ln-option-n" aria-hidden>{k + 1}</span>
              <span className="ln-option-t">{o.title}</span>
              {state === "right" && <IconCheck className="ln-option-ic" />}
              {state === "wrong" && <IconX className="ln-option-ic" />}
            </button>
          );
        })}
      </div>
      {answered && !ok && (
        <div className="ln-q-actions">
          <button ref={nextBtn} className="btn btn-primary btn-lg" onClick={props.onNext}>Кийинки <IconRight /></button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────── (b) Көрсөтүңүз ─────────────────────────

function ShowQuestion(props: {
  item: LearnItem;
  theme: "dark" | "light";
  signs: SignEntry[];
  recognizer: ReturnType<typeof useRecognizer>;
  labelOf: (gloss: string) => string;
  onAnswer: (item: LearnItem, ok: boolean) => void;
  onNext: () => void;
  trackId: string;
  cameraOn: boolean;
  setCameraOn: (v: boolean) => void;
}) {
  const { item, cameraOn, setCameraOn } = props;
  const [hint, setHint] = useState(false);
  const [tries, setTries] = useState(0);
  const [verdict, setVerdict] = useState<null | boolean>(null);
  const [speed, setSpeed] = useStored<Speed>("learnSpeed", 1);
  const onNext = useRef(props.onNext);
  onNext.current = props.onNext;

  useEffect(() => {
    if (verdict !== true) return;
    const t = window.setTimeout(() => onNext.current(), 1800);
    return () => window.clearTimeout(t);
  }, [verdict]);

  const settle = (ok: boolean) => {
    if (verdict !== null) return;
    setVerdict(ok);
    props.onAnswer(item, ok);
  };

  return (
    <div className="ln-q">
      <div className="ln-q-word">
        <small>{item.kind === "phrase" ? "Бул сүйлөмдү жест менен айтыңыз" : "Ушул сөздү жест менен көрсөтүңүз"}</small>
        <h2 className={`ln-big ${item.kind === "phrase" ? "phrase" : ""}`} lang="ky">{item.title}</h2>
        {item.ru && <p className="ln-ru" lang="ru">{item.ru}</p>}
      </div>
      <PracticeBox
        target={item.gloss}
        recognizer={props.recognizer}
        labelOf={props.labelOf}
        cameraOn={cameraOn}
        setCameraOn={setCameraOn}
        side={hint ? <SignPlayer theme={props.theme} gloss={item.gloss} signs={props.signs} speed={speed} onSpeed={setSpeed} className="compact" /> : undefined}
        hint="Окуп, жест менен көрсөтүңүз. Бүткөндө эки колуңузду түшүрүңүз."
        onResult={(r) => {
          if (verdict !== null) return;
          if (r.check.ok) settle(true);
          else {
            const t = tries + 1;
            setTries(t);
            if (t >= MAX_TRIES) settle(false);
          }
        }}
      />
      <div className="ln-q-actions">
        {verdict === null && (
          <>
            {!hint && <button className="btn" onClick={() => setHint(true)}><IconEye /> Көрсөтүп бер</button>}
            <button className="btn btn-ghost" onClick={() => settle(false)}><IconSkip /> Билбейм — өткөрүү</button>
            {tries > 0 && <span className="muted">Аракет: {tries}/{MAX_TRIES}</span>}
          </>
        )}
        {verdict === false && (
          <>
            <span className="ln-verdict bad"><IconX /> Бул жолу болгон жок — каталар тизмесине кошулду</span>
            {!hint && <button className="btn" onClick={() => setHint(true)}><IconEye /> Туурасын көрүү</button>}
            <button className="btn btn-primary btn-lg" onClick={props.onNext}>Кийинки <IconRight /></button>
          </>
        )}
        {verdict === true && <span className="ln-verdict ok"><IconCheck /> Туура! Кийинки суроо…</span>}
      </div>
      <p className="muted ln-q-alt">Камера жокпу? <button className="linkish" onClick={() => navigate(learnHash(props.trackId, "quiz"))}>«Бул кайсы жест?» тести</button> камерасыз иштейт.</p>
    </div>
  );
}

// ───────────────────────── Жыйынтык ─────────────────────────

function Summary(props: { track: Track; mode: "pick" | "show"; answers: Answer[]; onAgain: () => void; onExit: () => void }) {
  const { answers } = props;
  const correct = answers.filter((a) => a.ok).length;
  const mistakes = answers.filter((a) => !a.ok);
  const mastered = answers.filter((a) => a.mastered);
  const ratio = answers.length ? correct / answers.length : 0;
  const msg = ratio === 1 ? "Мыкты! Бардыгы туура." : ratio >= 0.7 ? "Абдан жакшы!" : ratio >= 0.4 ? "Жаман эмес — дагы бир аз машыгыңыз." : "Баштоо кыйын — карталарды кайра көрүп чыгыңыз.";

  return (
    <div className="ln-summary">
      <div className="ln-summary-head">
        <Ring value={ratio} size={120} stroke={9} tone={ratio >= 0.7 ? "ok" : "accent"} label={`${correct} / ${answers.length}`}>
          <span className="ln-summary-score"><b>{correct}</b>/{answers.length}</span>
        </Ring>
        <h1>{msg}</h1>
        <p className="muted">{props.track.title} · {props.mode === "pick" ? "Бул кайсы жест?" : "Көрсөтүңүз"}</p>
        {mastered.length > 0 && (
          <p className="ln-mastered"><IconTrophy /> Өздөштүрүлдү: {mastered.map((a) => a.item.title).join(", ")}</p>
        )}
      </div>

      {mistakes.length > 0 && (
        <section className="ln-section">
          <h2 className="card-title">Каталар — кайра карап чыгыңыз</h2>
          <div className="ln-mistakes">
            {mistakes.map((a) => {
              const k = props.track.items.findIndex((x) => x.key === a.item.key);
              return (
                <button key={a.item.key} className="ln-word" onClick={() => navigate(k >= 0 ? learnHash(props.track.id, "learn", k) : learnHash("review"))}>
                  <i className="lv bad" />
                  <span className="ln-word-t">{a.item.title}</span>
                  {a.item.ru && <span className="ln-word-ru">{a.item.ru}</span>}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <div className="ln-summary-actions">
        {mistakes.length > 0 && <button className="btn btn-primary btn-lg" onClick={() => navigate(learnHash("review", "learn", 0))}>Каталарды үйрөнүү</button>}
        <button className={`btn btn-lg ${mistakes.length ? "" : "btn-primary"}`} onClick={props.onAgain}>Дагы бир раунд</button>
        <button className="btn btn-ghost btn-lg" onClick={props.onExit}><IconLeft /> Темага кайтуу</button>
      </div>
      <p className="muted ln-hub-note">Ар бир жест {MASTER_N} жолу катары менен туура болгондо «өздөштүрүлдү» болот.</p>
    </div>
  );
}
