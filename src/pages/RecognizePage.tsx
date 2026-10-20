// Жест → текст → үн. Камера, MediaPipe, DTW классификатор + сүйлөм декодери (AI'сыз, браузерде).
//
// "Сүйлөм" режими (useSignCapture, utterance): бир нече жест катары менен көрсөтүлөт, жүрүп жатканда
// болжолдуу сөздөр көрүнөт; эки кол түшкөндө сүйлөм декоддолуп, дароо кыргызча сүйлөм түзүлөт.
import { useEffect, useRef, useState } from "react";
import { CameraView } from "../components/CameraView";
import { IconCamera, IconInfo, IconSpeaker, IconStop, IconTrash, IconSparkle, IconArrow } from "../components/icons";
import { glossToSentence, type ClaudeModel } from "../lib/api";
import { useStored } from "../lib/settings";
import { speak } from "../lib/speech";
import type { MocapClip } from "../lib/types";
import { setHandedness, setVocabularyMode, useRecognizer, useSignCapture, type UtteranceResult } from "../lib/recognizer";

export function RecognizePage(props: { model: ClaudeModel; claudeReady: boolean; goStudio: () => void }) {
  // Жалгыз таануу модели: китепкананын үлгүлөрү + Студиядагы жана жеке жаздыруулар (AI'сыз).
  const recognizer = useRecognizer();
  const [on, setOn] = useState(false);
  const [face, setFace] = useStored("recFace", false);
  const [threshold, setThreshold] = useStored("recThreshold2", 0.45);
  const [autoSpeak, setAutoSpeak] = useStored("autoSpeak", true);
  const [words, setWords] = useState<string[]>([]);
  const [last, setLast] = useState<UtteranceResult | null>(null);
  const [rejected, setRejected] = useState(false);
  const [sentence, setSentence] = useState("");
  const [composing, setComposing] = useState(false);
  const [voice, setVoice] = useState<"kyrgyz" | "browser" | "none" | null>(null);

  const vocabSize = recognizer.vocabulary;
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  const wordsRef = useRef(words);
  wordsRef.current = words;
  const composedFor = useRef("");

  const cap = useSignCapture({
    active: on,
    mode: "utterance",
    onUtterance: (_clip: MocapClip, result: UtteranceResult | null) => {
      if (!result || !result.gloss.length) return;
      setLast(result);
      // Сүйлөмдүн ишеними — эң начар жесттики; даяр сүйлөм дал келсе — кабыл алабыз
      const ok = !!result.phrase || result.confidence >= thresholdRef.current * 0.8;
      setRejected(!ok);
      if (!ok) return;
      const next = [...wordsRef.current, ...result.gloss];
      setWords(next);
      // Колдор түштү — сүйлөм дароо түзүлөт (даяр сүйлөм болсо — анын тексти)
      void compose(true, next, result.phrase && wordsRef.current.length === 0 ? result.phrase.text : null);
    },
  });

  async function compose(auto = false, ws = wordsRef.current, ready: string | null = null) {
    if (!ws.length) return;
    const key = ws.join(" ");
    if (auto && composedFor.current === key) return;
    composedFor.current = key;
    if (ready) {
      setSentence(ready);
      if (auto ? autoSpeak : true) setVoice(await speak(ready));
      return;
    }
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
    cap.reset();
  }

  useEffect(() => { if (!on) { setRejected(false); } }, [on]);

  const signing = cap.signing;
  const hyp = cap.hypothesis;

  return (
    <div className="grid-2">
      <div className="stack">
        <CameraView {...cap.cameraProps} face={face} accent="#ff9f6b">
          {on && (
            <div className="signal" aria-live="polite">
              {signing ? (
                <><span className="chip live" style={{ padding: 0, border: 0, background: "none" }}><span className="dot" /></span> {hyp.length ? `${hyp.map((g) => g.replace(/^#/, "")).join(" ")}…` : "Жест аныкталууда…"}</>
              ) : (
                <>✋ Жесттерди көрсөтүп, бүткөндө эки колуңузду түшүрүңүз</>
              )}
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
          <div className="row" style={{ marginTop: 10 }}>
            <label className="switch" title="Күнүмдүк сүйлөшүү сөздүгү тезирээк жана тагыраак; бүт китепкана — 1280 жест">
              <span className="muted">Сөздүк</span>
              <select value={recognizer.vocabularyMode} onChange={(e) => setVocabularyMode(e.target.value as "conversation" | "all")}>
                <option value="conversation">Сүйлөшүү (~280 жест)</option>
                <option value="all">Бүт китепкана</option>
              </select>
            </label>
            <label className="switch" title="Сол колдуу адам үчүн кадрлар күзгүдөй чагылдырылат">
              <span className="muted">Негизги кол</span>
              <select value={recognizer.handedness} onChange={(e) => setHandedness(e.target.value as "auto" | "right" | "left")}>
                <option value="auto">Автоматтык</option>
                <option value="right">Оң</option>
                <option value="left">Сол</option>
              </select>
            </label>
            <div className="spacer" />
            <span className="muted">{recognizer.loading ? "Модель жүктөлүүдө…" : `${vocabSize} жест`}</span>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="page-intro">
          <h1>Жест көрсөтүңүз — текст жана үн чыгат</h1>
          <p>Сүйлөмдү жесттер менен катары көрсөтүп, бүткөндө эки колуңузду түшүрүңүз — система сүйлөмдү ошондо тааныйт. Даяр сүйлөмдөр дароо, башкалары глосстордон түзүлөт.</p>
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
            {words.length ? words.map((w, i) => <span key={i} className="word">{w.replace(/^#/, "")}</span>) : <span className="placeholder">Жесттер ушул жерде пайда болот…</span>}
            {signing && hyp.map((w, i) => <span key={`h${i}`} className="word" style={{ opacity: 0.5 }}>{w.replace(/^#/, "")}</span>)}
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
              <div className="muted" style={{ marginBottom: 4 }}>Кыргызча сүйлөм {last?.phrase && composedFor.current === words.join(" ") && words.join(" ") === last.phrase.gloss.join(" ") ? "(даяр сүйлөм)" : props.claudeReady ? "(Claude)" : ""}</div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{sentence}</div>
              {voice === "browser" && <div className="muted" style={{ marginTop: 6 }}>Кыргызча TTS кызматы иштебей жатат — браузердин үнү колдонулду.</div>}
            </div>
          )}
        </div>

        <div className="card card-pad">
          <div className="card-head">
            <h2 className="card-title">Акыркы сүйлөм</h2>
            {last && <span className={`chip ${rejected ? "bad" : "ok"}`}><span className="dot" />{rejected ? "Кабыл алынган жок" : "Кабыл алынды"}</span>}
          </div>
          {last ? (
            <div className="candidates">
              {last.segments.map((c, i) => (
                <div className="cand" key={`${c.gloss}-${i}`}>
                  <span>{c.gloss.replace(/^#/, "")} <span className="muted mono">{(c.startMs / 1000).toFixed(1)}–{(c.endMs / 1000).toFixed(1)} с</span></span>
                  <div className="bar"><i style={{ width: `${Math.round(c.confidence * 100)}%` }} /></div>
                  <span className="mono">{Math.round(c.confidence * 100)}%</span>
                </div>
              ))}
              {last.phrase && <p className="muted" style={{ margin: "8px 0 0" }}>Даяр сүйлөм: «{last.phrase.text}»</p>}
              {last.stats && <p className="muted mono" style={{ margin: "6px 0 0", fontSize: 12 }}>декод {last.stats.decodeMs.toFixed(0)} мс</p>}
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
