// Жест → текст → үн. Камера, MediaPipe, DTW классификатор.
import { useEffect, useRef, useState } from "react";
import { CameraView } from "../components/CameraView";
import { IconCamera, IconInfo, IconSpeaker, IconStop, IconTrash, IconSparkle, IconArrow } from "../components/icons";
import { glossToSentence, type ClaudeModel } from "../lib/api";
import { useStored } from "../lib/settings";
import { speak } from "../lib/speech";
import type { Recognition } from "../lib/types";
import { useRecognizer } from "../lib/recognizer";
import { SignSegmenter, type TrackResult } from "../vision";

export function RecognizePage(props: { model: ClaudeModel; claudeReady: boolean; goStudio: () => void }) {
  // Жалгыз таануу модели: китепкананын ~1400 үлгүсү + Студиядагы жаздыруулар (AI'сыз).
  const recognizer = useRecognizer();
  const classifierRef = useRef(recognizer.classifier);
  classifierRef.current = recognizer.classifier;
  const [on, setOn] = useState(false);
  const [face, setFace] = useStored("recFace", false);
  const [threshold, setThreshold] = useStored("recThreshold", 0.55);
  const [autoSpeak, setAutoSpeak] = useStored("autoSpeak", true);
  const [words, setWords] = useState<string[]>([]);
  const [last, setLast] = useState<Recognition | null>(null);
  const [rejected, setRejected] = useState(false);
  const [signing, setSigning] = useState(false);
  const [sentence, setSentence] = useState("");
  const [composing, setComposing] = useState(false);
  const [voice, setVoice] = useState<"kyrgyz" | "browser" | "none" | null>(null);

  const vocabSize = recognizer.vocabulary;

  const segmenter = useRef(new SignSegmenter());
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const pauseTimer = useRef<number>(0);
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const composedFor = useRef("");

  function onFrame(res: TrackResult) {
    const seg = segmenter.current.push(res.frame);
    const active = segmenter.current.active;
    setSigning((prev) => (prev === active ? prev : active));
    if (active) window.clearTimeout(pauseTimer.current);
    if (!seg) return;
    const r = classifierRef.current?.classify(seg);
    if (!r) return;
    setLast(r);
    if (r.confidence >= thresholdRef.current) {
      setRejected(false);
      setWords((w) => [...w, r.gloss]);
      // Колдонуучу 2.5 сек токтосо — сүйлөм түзөбүз.
      window.clearTimeout(pauseTimer.current);
      pauseTimer.current = window.setTimeout(() => compose(true), 2500);
    } else {
      setRejected(true);
    }
  }

  async function compose(auto = false) {
    const ws = wordsRef.current;
    if (!ws.length) return;
    const key = ws.join(" ");
    if (auto && composedFor.current === key) return;
    composedFor.current = key;
    setComposing(true);
    try {
      const r = await glossToSentence(ws, { model: props.model });
      setSentence(r.sentence);
      if (auto ? autoSpeak : true) setVoice(await speak(r.sentence));
    } catch {
      setSentence(ws.join(" "));
    } finally {
      setComposing(false);
    }
  }

  function clear() {
    setWords([]);
    setSentence("");
    setLast(null);
    setRejected(false);
    composedFor.current = "";
    segmenter.current.reset();
  }

  useEffect(() => () => window.clearTimeout(pauseTimer.current), []);
  useEffect(() => { if (!on) { segmenter.current.reset(); setSigning(false); } }, [on]);

  return (
    <div className="grid-2">
      <div className="stack">
        <CameraView active={on} face={face} onFrame={onFrame} accent="#ff9f6b">
          {on && (
            <div className="signal" aria-live="polite">
              {signing ? <><span className="chip live" style={{ padding: 0, border: 0, background: "none" }}><span className="dot" /></span> Жест аныкталууда…</> : <>✋ Жест көрсөтүңүз</>}
            </div>
          )}
          {!on && (
            <div className="stage-center">
              <div style={{ maxWidth: 340 }}>
                <p style={{ color: "var(--text-2)", marginTop: 0 }}>Камера колуңузду, денеңизди жана бетиңизди көзөмөлдөйт. Видео эч жакка жөнөтүлбөйт — баары браузерде иштейт.</p>
                <button className="btn btn-primary" onClick={() => setOn(true)}><IconCamera /> Камераны күйгүзүү</button>
              </div>
            </div>
          )}
        </CameraView>

        <div className="card card-pad">
          <div className="row">
            {on && <button className="btn btn-sm" onClick={() => setOn(false)}><IconStop /> Камераны өчүрүү</button>}
            <label className="switch"><input type="checkbox" checked={face} onChange={(e) => setFace(e.target.checked)} /> Бет мимикасы</label>
            <label className="switch"><input type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} /> Автоматтык үн</label>
            <div className="spacer" />
            <label className="switch" title="Ушундан төмөн ишеним менен таанылган жест кабыл алынбайт">
              <span className="muted">Ишеним босогосу</span>
              <input className="range" type="range" min={0.3} max={0.9} step={0.05} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
              <span className="mono">{Math.round(threshold * 100)}%</span>
            </label>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="page-intro">
          <h1>Жест көрсөтүңүз — текст жана үн чыгат</h1>
          <p>Ар бир жесттен кийин колуңузду бир аз түшүрүңүз — система жесттерди ошентип бөлүп тааныйт. Таанылган сөздөрдөн Claude табигый кыргызча сүйлөм түзөт.</p>
        </div>

        {!recognizer.loading && vocabSize === 0 && (
          <div className="notice">
            <IconInfo />
            <div>
              Тааный турган жест азырынча жок. Студияда ар бир жестти 5 жолудан жаздырыңыз — классификатор ошолордон үйрөнөт.
              <div style={{ marginTop: 10 }}><button className="btn btn-sm" onClick={props.goStudio}>Студияга өтүү <IconArrow /></button></div>
            </div>
          </div>
        )}

        <div className="card card-pad">
          <div className="card-head">
            <h2 className="card-title">Таанылган жесттер</h2>
            <button className="btn btn-sm btn-ghost" onClick={clear} disabled={!words.length}><IconTrash /> Тазалоо</button>
          </div>
          <div className="transcript" aria-live="polite">
            {words.length ? words.map((w, i) => <span key={i} className="word">{w}</span>) : <span className="placeholder">Жесттер ушул жерде пайда болот…</span>}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={() => compose(false)} disabled={!words.length || composing}>
              {composing ? <><span className="spinner" /> Түзүлүүдө…</> : <><IconSparkle /> Сүйлөм түзүп, окуу</>}
            </button>
            <button className="btn" onClick={async () => setVoice(await speak(sentence || words.join(" ")))} disabled={!words.length}>
              <IconSpeaker /> Үн
            </button>
            <button className="btn btn-ghost" onClick={() => setWords((w) => w.slice(0, -1))} disabled={!words.length}>⌫ Акыркысы</button>
          </div>
          {sentence && (
            <div style={{ marginTop: 16 }}>
              <div className="muted" style={{ marginBottom: 4 }}>Кыргызча сүйлөм {props.claudeReady ? "(Claude)" : ""}</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{sentence}</div>
              {voice === "browser" && <div className="muted" style={{ marginTop: 6 }}>Кыргызча TTS кызматы иштебей жатат — браузердин үнү колдонулду.</div>}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <div className="card-head">
            <h2 className="card-title">Акыркы жест</h2>
            {last && <span className={`chip ${rejected ? "bad" : "ok"}`}><span className="dot" />{rejected ? "Кабыл алынган жок" : "Кабыл алынды"}</span>}
          </div>
          {last ? (
            <div className="candidates">
              {[{ gloss: last.gloss, confidence: last.confidence }, ...last.alternatives].slice(0, 4).map((c) => (
                <div className="cand" key={c.gloss}>
                  <span>{c.gloss}</span>
                  <div className="bar"><i style={{ width: `${Math.round(c.confidence * 100)}%` }} /></div>
                  <span className="mono">{Math.round(c.confidence * 100)}%</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {recognizer.loading ? "Таануу модели жүктөлүүдө…" : `Сөздүк: ${vocabSize ? `${vocabSize} жест` : "бош"}`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
