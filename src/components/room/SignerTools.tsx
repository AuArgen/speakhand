// Жаңсоочунун куралдары: камера менен жест таануу → сөздөр долбоору → сүйлөм → автоматтык жөнөтүү;
// даяр сүйлөмдөр жана сөз тандагыч (камерасыз эң тез жол); текст жазуу.
//
// Камера "сүйлөм" режиминде иштейт (useSignCapture, utterance): колдонуучу бир нече жестти катары
// менен көрсөтөт, жүрүп жатканда болжолдуу сөздөр көрүнөт; ЭКИ колун түшүргөндө сүйлөм декоддолот
// (даяр сүйлөм дал келсе — анын тексти, болбосо глосстордон түзүлгөн сүйлөм) жана кыска убакыттан
// кийин (токтотууга мүмкүнчүлүк менен) жөнөтүлөт.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { composeSentence } from "../../lib/compose";
import type { PhraseItem } from "../../lib/room";
import { useSignCapture, type RecognizerState, type UtteranceResult } from "../../lib/recognizer";
import type { MocapClip, Recognition, SignEntry } from "../../lib/types";
import type { RoomHook } from "../../hooks/useRoom";
import { vibrate } from "../../hooks/useHaptics";
import type { TrackResult } from "../../vision";
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

/** Колдор түшкөндөн кийин жөнөтүүгө чейинки терезе (токтотуу үчүн), мс — ылдамдык маанилүү */
const SEND_WINDOW_MS = 1500;

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
  const [last, setLast] = useState<{ r: Recognition; ok: boolean; phrase: string | null } | null>(null);
  const [text, setText] = useState("");
  /** Камера күйгүзүлгөндөн кийин узак убакыт кадр келбесе — кеңеш көрсөтөбүз */
  const [cameraStuck, setCameraStuck] = useState(false);
  const gotFrame = useRef(false);

  const timer = useRef(0);
  /** Долбоор так ушул даяр сүйлөмдүн глосстору болсо — анын тексти жөнөтүлөт */
  const phraseFor = useRef<{ key: string; text: string } | null>(null);
  const typingTimer = useRef(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fromCameraRef = useRef(fromCamera);
  fromCameraRef.current = fromCamera;
  const settings = useRef(props.settings);
  settings.current = props.settings;
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
    const pf = phraseFor.current;
    const c = composeSentence(d, { phrases: props.phraseIndex, signs: props.signs });
    const text = pf && pf.key === d.join(" ") ? pf.text : c.text || d.join(" ");
    send(text, { via: fromCameraRef.current ? "sign" : "quick", gloss: d });
    setDraft([]);
    setFromCamera(false);
    setLast(null);
    phraseFor.current = null;
    vibrate(25);
  }, [cancelTimer, props.phraseIndex, props.signs, send]);

  const armTimer = useCallback((ms = settings.current.autoSendMs) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(sendDraft, ms);
    setCountdown((c) => ({ key: (c?.key ?? 0) + 1, ms }));
  }, [sendDraft]);

  function addWord(gloss: string, camera: boolean) {
    setDraft((d) => [...d, gloss]);
    phraseFor.current = null;
    if (camera) setFromCamera(true);
    armTimer();
  }

  /** Камерадан келген сүйлөм: сөздөр долбоорго кошулат, кыска терезеден кийин жөнөтүлөт */
  function addUtterance(gloss: string[], phraseText: string | null) {
    const d = draftRef.current;
    const next = [...d, ...gloss];
    phraseFor.current = phraseText && !d.length ? { key: next.join(" "), text: phraseText } : null;
    setDraft(next);
    setFromCamera(true);
    armTimer(Math.min(settings.current.autoSendMs, SEND_WINDOW_MS));
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
    phraseFor.current = null;
    cap.reset();
  }

  useEffect(() => {
    gotFrame.current = false;
    setCameraStuck(false);
    if (!cameraOn) return;
    const t = window.setTimeout(() => { if (!gotFrame.current) setCameraStuck(true); }, 12_000);
    return () => window.clearTimeout(t);
  }, [cameraOn]);

  // ----- Камера → сүйлөм (utterance) → декодер -----
  const cap = useSignCapture({
    active: cameraOn && mode === "camera",
    mode: "utterance",
    onUtterance: (_clip: MocapClip, result: UtteranceResult | null) => {
      if (!result || !result.gloss.length) {
        if (draftRef.current.length) armTimer(SEND_WINDOW_MS);
        return;
      }
      // Сүйлөмдүн ишеними — эң начар жесттики; даяр сүйлөм дал келсе — кабыл алабыз
      const ok = !!result.phrase || result.confidence >= settings.current.threshold * 0.8;
      setLast({ r: { gloss: result.gloss.join(" "), confidence: result.confidence, alternatives: [] }, ok, phrase: result.phrase?.text ?? null });
      if (ok) addUtterance(result.gloss, result.phrase?.text ?? null);
      else if (draftRef.current.length) armTimer(SEND_WINDOW_MS);
    },
  });
  const signing = cap.signing;
  const capFrame = cap.cameraProps.onFrame;
  const onFrame = useCallback((res: TrackResult) => {
    if (!gotFrame.current) { gotFrame.current = true; setCameraStuck(false); }
    capFrame(res);
  }, [capFrame]);

  useEffect(() => {
    setStatus(signing ? "signing" : "idle");
    // Сүйлөм жүрүп жатат — таймерди токтотобуз (долбоор сакталат, сөздөр кошулат)
    if (signing && timer.current) {
      window.clearTimeout(timer.current);
      timer.current = 0;
      setCountdown(null);
    }
  }, [signing, setStatus]);

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
                      <><span className="chip live" style={{ padding: 0, border: 0, background: "none" }}><span className="dot" /></span> {cap.hypothesis.length ? cap.hypothesis.map((g) => g.replace(/^#/, "")).join(" ") + "…" : "Жест аныкталууда…"}</>
                    ) : (
                      <>✋ Жесттерди көрсөтүп, бүткөндө эки колуңузду түшүрүңүз</>
                    )}
                  </div>
                )}
                {!cameraOn && (
                  <div className="stage-center">
                    <div className="rm-camera-off">
                      <button className="btn btn-primary btn-lg" onClick={() => setCameraOn(true)}><IconCamera /> Камераны күйгүзүү</button>
                      <p className="muted">Видео эч жакка жөнөтүлбөйт — таануу браузерде иштейт. Сүйлөмдү жесттер менен көрсөтүп, бүткөндө эки колуңузду түшүрүңүз — ошондо жөнөтүлөт.</p>
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
                <span className={`chip ${last.ok ? "ok" : "bad"}`} title={last.phrase ? `Даяр сүйлөм: ${last.phrase}` : last.ok ? "Кабыл алынды" : "Ишеним төмөн — кайра көрсөтүңүз"}>
                  <span className="dot" /> {last.r.gloss.replace(/#/g, "")} · {Math.round(last.r.confidence * 100)}%{last.phrase ? " · даяр сүйлөм" : ""}
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
