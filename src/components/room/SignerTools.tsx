// Жаңсоочунун куралдары: камера менен жест таануу → сөздөр долбоору → сүйлөм → автоматтык жөнөтүү;
// даяр сүйлөмдөр жана сөз тандагыч (камерасыз эң тез жол); текст жазуу.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { composeSentence } from "../../lib/compose";
import type { PhraseItem } from "../../lib/room";
import type { RecognizerState } from "../../lib/recognizer";
import type { Recognition, SignEntry } from "../../lib/types";
import type { RoomHook } from "../../hooks/useRoom";
import { vibrate } from "../../hooks/useHaptics";
import { SignSegmenter, type TrackResult } from "../../vision";
import { CameraView } from "../CameraView";
import { IconCamera, IconHand, IconInfo, IconStop, IconX } from "../icons";
import { QuickPhrases } from "./QuickPhrases";
import { IconBolt, IconGrid, IconKeyboard, IconSend, IconUndo } from "./roomIcons";
import type { RoomSettings } from "./settings";
import { WordPicker } from "./WordPicker";

export type ToolMode = "camera" | "phrases" | "words" | "text";

const MODES: { id: ToolMode; label: string; icon: typeof IconHand }[] = [
  { id: "camera", label: "Жест", icon: IconHand },
  { id: "phrases", label: "Сүйлөмдөр", icon: IconBolt },
  { id: "words", label: "Сөздөр", icon: IconGrid },
  { id: "text", label: "Жазуу", icon: IconKeyboard },
];

export function SignerTools(props: {
  send: RoomHook["send"];
  setStatus: RoomHook["setStatus"];
  phrases: PhraseItem[];
  phraseIndex: Map<string, PhraseItem>;
  phrasesLoading: boolean;
  recentPhrases: string[];
  onPhraseUsed: (text: string) => void;
  signs: SignEntry[];
  signsLoading: boolean;
  recognizer: RecognizerState;
  settings: RoomSettings;
  /** Кең экранда даяр сүйлөмдөр өзүнчө тилкеде — бул жерде көрсөтүлбөйт */
  hidePhrases?: boolean;
  initialMode?: ToolMode;
}) {
  const [mode, setMode] = useState<ToolMode>(props.initialMode ?? "camera");
  const [cameraOn, setCameraOn] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [fromCamera, setFromCamera] = useState(false);
  const [countdown, setCountdown] = useState<{ key: number; ms: number } | null>(null);
  const [signing, setSigning] = useState(false);
  const [last, setLast] = useState<{ r: Recognition; ok: boolean } | null>(null);
  const [text, setText] = useState("");
  /** Камера күйгүзүлгөндөн кийин узак убакыт кадр келбесе — кеңеш көрсөтөбүз */
  const [cameraStuck, setCameraStuck] = useState(false);
  const gotFrame = useRef(false);

  const segmenter = useRef(new SignSegmenter());
  const timer = useRef(0);
  const typingTimer = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fromCameraRef = useRef(fromCamera);
  fromCameraRef.current = fromCamera;
  const settings = useRef(props.settings);
  settings.current = props.settings;
  const classifier = useRef(props.recognizer.classifier);
  classifier.current = props.recognizer.classifier;
  const { send, setStatus } = props;

  const composed = useMemo(
    () => composeSentence(draft, { phrases: props.phraseIndex, signs: props.signs }),
    [draft, props.phraseIndex, props.signs],
  );

  const cancelTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    setCountdown(null);
  }, []);

  const sendDraft = useCallback(() => {
    const d = draftRef.current;
    cancelTimer();
    if (!d.length) return;
    const c = composeSentence(d, { phrases: props.phraseIndex, signs: props.signs });
    send(c.text || d.join(" "), { via: fromCameraRef.current ? "sign" : "quick", gloss: d });
    setDraft([]);
    setFromCamera(false);
    setLast(null);
    segmenter.current.reset();
    vibrate(25);
  }, [cancelTimer, props.phraseIndex, props.signs, send]);

  const armTimer = useCallback(() => {
    window.clearTimeout(timer.current);
    const ms = settings.current.autoSendMs;
    timer.current = window.setTimeout(sendDraft, ms);
    setCountdown((c) => ({ key: (c?.key ?? 0) + 1, ms }));
  }, [sendDraft]);

  function addWord(gloss: string, camera: boolean) {
    setDraft((d) => [...d, gloss]);
    if (camera) setFromCamera(true);
    armTimer();
  }

  function removeWord(i: number) {
    setDraft((d) => d.filter((_, j) => j !== i));
    if (draftRef.current.length <= 1) cancelTimer();
    else armTimer();
  }

  function clearDraft() {
    cancelTimer();
    setDraft([]);
    setFromCamera(false);
    setLast(null);
    segmenter.current.reset();
  }

  useEffect(() => {
    gotFrame.current = false;
    setCameraStuck(false);
    if (!cameraOn) return;
    const t = window.setTimeout(() => { if (!gotFrame.current) setCameraStuck(true); }, 12_000);
    return () => window.clearTimeout(t);
  }, [cameraOn]);

  // ----- Камера → сегмент → классификатор -----
  function onFrame(res: TrackResult) {
    if (!gotFrame.current) { gotFrame.current = true; setCameraStuck(false); }
    const seg = segmenter.current.push(res.frame);
    const active = segmenter.current.active;
    setSigning((prev) => (prev === active ? prev : active));
    if (active) {
      // Жест жүрүп жатат — таймерди токтотобуз (долбоор сакталат)
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = 0;
        setCountdown(null);
      }
    }
    if (!seg) return;
    const c = classifier.current;
    if (!c) return;
    const r = c.classify(seg);
    if (!r) {
      if (draftRef.current.length) armTimer();
      return;
    }
    const ok = r.confidence >= settings.current.threshold;
    setLast({ r, ok });
    if (ok) addWord(r.gloss, true);
    else if (draftRef.current.length) armTimer();
  }

  useEffect(() => {
    setStatus(signing ? "signing" : "idle");
  }, [signing, setStatus]);

  useEffect(() => {
    if (!cameraOn) {
      segmenter.current.reset();
      setSigning(false);
    }
  }, [cameraOn]);

  useEffect(() => () => { window.clearTimeout(timer.current); window.clearTimeout(typingTimer.current); }, []);

  // ----- Даяр сүйлөм: дароо жөнөтүү -----
  function pickPhrase(p: PhraseItem) {
    send(p.text, { via: "quick", gloss: p.gloss });
    props.onPhraseUsed(p.text);
    vibrate(25);
  }

  // ----- Текст -----
  function onType(v: string) {
    setText(v);
    if (v.trim()) {
      setStatus("typing");
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setStatus("idle"), 3000);
    } else setStatus("idle");
  }
  function submitText() {
    const t = text.trim();
    if (!t) return;
    send(t, { via: "text" });
    setText("");
  }
  function onTextKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitText(); }
  }

  const modes = props.hidePhrases ? MODES.filter((m) => m.id !== "phrases") : MODES;
  const vocab = props.recognizer.vocabulary;

  return (
    <div className="tools">
      {(draft.length > 0 || countdown) && (
        <div className="draft" role="region" aria-label="Жөнөтүлө турган сүйлөм">
          <div className="draft-chips">
            {draft.map((g, i) => (
              <button key={`${g}-${i}`} className="draft-chip" onClick={() => removeWord(i)} aria-label={`${g} — өчүрүү`} title="Басып өчүрүңүз">
                {g.replace(/^#/, "")} <IconX />
              </button>
            ))}
            {draft.length > 0 && (
              <button className="rm-iconbtn sm" onClick={() => removeWord(draft.length - 1)} aria-label="Акыркы сөздү өчүрүү" title="Акыркы сөздү өчүрүү"><IconUndo /></button>
            )}
          </div>
          <div className="draft-preview" aria-live="polite">
            {composed.text || "…"}
            {composed.source === "phrase" && <span className="chip rec" style={{ marginLeft: 8 }}>даяр сүйлөм</span>}
          </div>
          <div className="draft-actions">
            <button className="btn btn-ghost btn-sm" onClick={clearDraft}>Тазалоо</button>
            <div className="spacer" />
            {countdown ? (
              <button className="btn btn-sm" onClick={cancelTimer} aria-label="Автоматтык жөнөтүүнү токтотуу">
                <CountdownRing key={countdown.key} ms={countdown.ms} /> Токтотуу
              </button>
            ) : (
              draft.length > 0 && <span className="muted">Автоматтык жөнөтүү токтотулду</span>
            )}
            <button className="btn btn-primary" onClick={sendDraft} disabled={!draft.length}><IconSend /> Жөнөтүү</button>
          </div>
        </div>
      )}

      <div className="tools-seg" role="tablist" aria-label="Кантип сүйлөйсүз">
        {modes.map(({ id, label, icon: I }) => (
          <button key={id} role="tab" aria-selected={mode === id} className="tools-tab" onClick={() => setMode(id)}>
            <I /> <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="tools-body">
        {mode === "camera" && (
          <div className="rm-camera-wrap">
            <div className="rm-camera">
              <CameraView active={cameraOn} face={false} onFrame={onFrame} accent="#3dd6c3">
                {cameraOn && (
                  <div className="signal" aria-live="polite">
                    {!props.recognizer.classifier ? (
                      <><span className="spinner" /> Жесттер жүктөлүүдө…</>
                    ) : signing ? (
                      <><span className="chip live" style={{ padding: 0, border: 0, background: "none" }}><span className="dot" /></span> Жест аныкталууда…</>
                    ) : (
                      <>✋ Жест көрсөтүңүз</>
                    )}
                  </div>
                )}
                {!cameraOn && (
                  <div className="stage-center">
                    <div className="rm-camera-off">
                      <button className="btn btn-primary btn-lg" onClick={() => setCameraOn(true)}><IconCamera /> Камераны күйгүзүү</button>
                      <p className="muted">Видео эч жакка жөнөтүлбөйт — таануу браузерде иштейт. Ар бир жесттен кийин колуңузду бир аз түшүрүңүз.</p>
                    </div>
                  </div>
                )}
              </CameraView>
            </div>
            <div className="rm-camera-bar">
              {cameraOn ? (
                <button className="btn btn-sm" onClick={() => setCameraOn(false)}><IconStop /> Өчүрүү</button>
              ) : (
                <span className="muted">Камера өчүк</span>
              )}
              <span className="chip" title="Тааный турган жесттер">{props.recognizer.loading ? <span className="spinner" /> : <IconHand style={{ width: 14 }} />} {vocab} жест</span>
              {last && (
                <span className={`chip ${last.ok ? "ok" : "bad"}`} title={last.r.alternatives.slice(0, 2).map((a) => `${a.gloss} ${Math.round(a.confidence * 100)}%`).join(", ")}>
                  <span className="dot" /> {last.r.gloss} · {Math.round(last.r.confidence * 100)}%
                </span>
              )}
            </div>
            {cameraOn && cameraStuck && (
              <div className="notice">
                <IconInfo />
                <span>Камера жооп бербей жатат. Браузерде камерага уруксат барбы, текшериңиз — же <button className="linkish" onClick={() => setMode(props.hidePhrases ? "words" : "phrases")}>даяр сүйлөмдөр</button> менен сүйлөңүз.</span>
              </div>
            )}
            {!cameraOn && !draft.length && (
              <p className="tools-hint">Камерасыз да сүйлөй аласыз: <button className="linkish" onClick={() => setMode(props.hidePhrases ? "words" : "phrases")}>даяр сүйлөмдөр</button> же <button className="linkish" onClick={() => setMode("words")}>сөздөр</button> — бир басуу менен жөнөтүлөт.</p>
            )}
          </div>
        )}

        {mode === "phrases" && (
          <QuickPhrases phrases={props.phrases} recent={props.recentPhrases} onPick={pickPhrase} loading={props.phrasesLoading} />
        )}

        {mode === "words" && (
          <>
            <p className="tools-hint" style={{ marginTop: 0 }}>Сөзгө басыңыз — сүйлөмгө кошулат жана {(props.settings.autoSendMs / 1000).toFixed(1)} с кийин өзү жөнөтүлөт. Бир нече сөз басса — сүйлөм түзүлөт.</p>
            <WordPicker signs={props.signs} loading={props.signsLoading} onPick={(s) => addWord(s.gloss, false)} />
          </>
        )}

        {mode === "text" && (
          <div className="tools-text">
            <textarea
              value={text}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={onTextKey}
              placeholder="Жазыңыз… (Enter — жөнөтүү)"
              aria-label="Билдирүү жазуу"
              rows={3}
              enterKeyHint="send"
            />
            <div className="row">
              <div className="spacer" />
              <button className="btn btn-primary" onClick={submitText} disabled={!text.trim()}><IconSend /> Жөнөтүү</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Автоматтык жөнөтүүгө чейинки убакыт — айлана */
function CountdownRing({ ms }: { ms: number }) {
  return (
    <svg className="ring" viewBox="0 0 24 24" aria-hidden style={{ ["--ms" as string]: `${ms}ms` }}>
      <circle cx="12" cy="12" r="9" className="ring-bg" />
      <circle cx="12" cy="12" r="9" className="ring-fg" />
    </svg>
  );
}
