// «Кайталаңыз»: камера → бир айтылыш (кол көтөрүлгөндөн ЭКИ кол тең түшкөнгө чейин) → текшерүү:
//   бир сөз — checkSign, сүйлөм — checkSequence (ар бир жест ✓/✗) → окшоштук, кайра аракет.
// Туура болсо (же колдонуучу «бул туура болчу» десе) — жеке үлгү катары сакталат: таануу ушул адамды тезирээк тааныйт.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { RecognizerState } from "../../lib/recognizer";
import type { MocapClip } from "../../lib/types";
import type { TrackResult } from "../../vision";
import { CameraView } from "../CameraView";
import { IconCamera, IconInfo, IconReplay, IconStop, IconX } from "../icons";
import { IconCheck } from "../room/roomIcons";
import { IconSave } from "./learnIcons";
import { checkSequence, checkSign, personalSampleCount, savePersonalSample, useSignCapture, type SequenceCheck } from "./signCheck";

export type CameraProbe = "checking" | "ok" | "insecure" | "unsupported" | "none" | "denied";

/** Камера барбы, уруксат четке кагылганбы — камераны күйгүзбөй туруп текшерет. */
export async function probeCamera(): Promise<CameraProbe> {
  if (!window.isSecureContext) return "insecure";
  if (!navigator.mediaDevices?.getUserMedia) return "unsupported";
  try {
    const p = await navigator.permissions?.query({ name: "camera" as PermissionName });
    if (p?.state === "denied") return "denied";
  } catch {
    /* Safari/Firefox: camera уруксаты суралбайт */
  }
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    if (!list.some((d) => d.kind === "videoinput")) return "none";
  } catch {
    /* белгисиз — аракет кылып көрөбүз */
  }
  return "ok";
}

const PROBE_TEXT: Record<Exclude<CameraProbe, "checking" | "ok">, string> = {
  insecure: "Камера коопсуз байланышта гана иштейт (https же localhost). Шилтемени https менен ачыңыз.",
  unsupported: "Бул браузер камераны колдобойт. Chrome же Safari'нин жаңы версиясын колдонуңуз.",
  none: "Камера табылган жок. Камерасы бар түзмөктөн ачыңыз — же «Бул кайсы жест?» тестин камерасыз эле өтүңүз.",
  denied: "Камерага уруксат берилген жок. Браузердин дарек тилкесиндеги 🔒 белгисин басып, камерага уруксат бериңиз.",
};

type CaptureState = "idle" | "ready" | "recording";

/**
 * Камера + айтылышты кармоо (useSignCapture, "utterance" режими): кол көтөрүлгөндө жазуу башталат;
 * ЭКИ кол тең түшүрүлгөндө айтылыш бүтөт жана onUtterance аркылуу бир клип катары берилет.
 */
export function PracticeCamera(props: {
  on: boolean;
  setOn: (v: boolean) => void;
  onUtterance: (clip: MocapClip) => void;
  /** true — кармалбайт (модель жүктөлүүдө / текшерилип жатат) */
  paused?: boolean;
  /** Текшерилип жатат — индикатор үчүн */
  checking?: boolean;
  hint?: string;
  children?: ReactNode;
}) {
  const [probe, setProbe] = useState<CameraProbe>("checking");
  const [hands, setHands] = useState(false);
  const [stuck, setStuck] = useState(false);
  const gotFrame = useRef(false);
  const onUtterance = useRef(props.onUtterance);
  onUtterance.current = props.onUtterance;
  const paused = useRef(props.paused);
  paused.current = props.paused;

  useEffect(() => {
    let alive = true;
    probeCamera().then((p) => alive && setProbe(p));
    return () => { alive = false; };
  }, [props.on]);

  const blockedNow = probe !== "checking" && probe !== "ok";
  const cap = useSignCapture({
    active: props.on && !blockedNow,
    mode: "utterance",
    onUtterance: (clip) => { if (!paused.current) onUtterance.current(clip); },
  });
  const { reset } = cap;

  useEffect(() => {
    gotFrame.current = false;
    setStuck(false);
    setHands(false);
    if (!props.on) return;
    const t = window.setTimeout(() => { if (!gotFrame.current) setStuck(true); }, 15_000);
    return () => window.clearTimeout(t);
  }, [props.on]);

  useEffect(() => {
    if (props.paused) reset();
  }, [props.paused, reset]);

  const capFrame = cap.cameraProps.onFrame;
  const onFrame = useCallback((res: TrackResult) => {
    if (!gotFrame.current) { gotFrame.current = true; setStuck(false); }
    const h = Boolean(res.frame.leftHand || res.frame.rightHand);
    setHands((p) => (p === h ? p : h));
    if (!paused.current) capFrame(res);
  }, [capFrame]);

  const state: CaptureState = cap.signing ? "recording" : hands ? "ready" : "idle";

  const blocked = probe !== "checking" && probe !== "ok";
  const live = props.on && !blocked;

  return (
    <div className="ln-cam">
      <CameraView active={live} face={false} onFrame={onFrame} accent="#3dd6c3">
        {live && (
          <div className="ln-cam-signal" aria-live="polite">
            {props.checking ? (
              <span className="ln-pill"><span className="spinner" /> Текшерилүүдө…</span>
            ) : props.paused ? null : state === "recording" ? (
              <span className="ln-pill rec"><span className="ln-rec-dot" /> Жазылууда… бүткөндө эки колуңузду түшүрүңүз</span>
            ) : state === "ready" ? (
              <span className="ln-pill">✋ Жаңсаңыз — колуңузду көтөрүңүз</span>
            ) : gotFrame.current ? (
              <span className="ln-pill">Колуңуз көрүнбөй жатат</span>
            ) : null}
          </div>
        )}
        {(!props.on || blocked) && (
          <div className="stage-center">
            <div className="ln-cam-off">
              {blocked ? (
                <div className="notice error" role="alert"><IconInfo /> <span>{PROBE_TEXT[probe as keyof typeof PROBE_TEXT]}</span></div>
              ) : (
                <>
                  <button className="btn btn-primary btn-lg" onClick={() => props.setOn(true)}><IconCamera /> Камераны күйгүзүү</button>
                  <p className="muted">{props.hint ?? "Видео эч жакка жөнөтүлбөйт — текшерүү ушул браузерде иштейт."}</p>
                </>
              )}
            </div>
          </div>
        )}
        {props.children}
      </CameraView>
      {props.on && stuck && !blocked && (
        <div className="notice"><IconInfo /><span>Камера жооп бербей жатат. Браузерде камерага уруксат барбы, башка программа камераны колдонуп жатабы — текшериңиз.</span></div>
      )}
      {props.on && !blocked && (
        <button className="btn btn-sm btn-ghost ln-cam-stop" onClick={() => props.setOn(false)}><IconStop /> Камераны өчүрүү</button>
      )}
    </div>
  );
}

export interface PracticeResult { check: SequenceCheck; clip: MocapClip }

/**
 * Камера + текшерүү + жыйынтык. target — күтүлгөн глосстор (бир сөз — бирөө, сүйлөм — бир нечеси).
 * onResult — ар бир аракеттен кийин (ok же жок).
 */
export function PracticeBox(props: {
  target: string[];
  recognizer: RecognizerState;
  labelOf: (gloss: string) => string;
  cameraOn: boolean;
  setCameraOn: (v: boolean) => void;
  onResult?: (r: PracticeResult) => void;
  /** Туура болгондо автоматтык түрдө жеке үлгү сактоо (демейки true; бир сөз үчүн гана) */
  autoSave?: boolean;
  /** Кошумча: камеранын жанындагы аватар (жанаша көрүү) */
  side?: ReactNode;
  hint?: string;
}) {
  const [result, setResult] = useState<PracticeResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [count, setCount] = useState<number | null>(null);
  const { classifier } = props.recognizer;
  const single = props.target.length === 1;
  const key = props.target.join(" ");

  useEffect(() => {
    setResult(null);
    setSaved("idle");
    setCount(null);
    if (!single) return;
    let alive = true;
    personalSampleCount(key).then((n) => alive && setCount(n)).catch(() => alive && setCount(null));
    return () => { alive = false; };
  }, [key, single]);

  const save = useCallback(async (clip: MocapClip) => {
    if (!single) return;
    setSaved("saving");
    try {
      const n = await savePersonalSample(key, clip);
      setCount(n);
      setSaved("saved");
    } catch (e) {
      console.warn("[learn] үлгү сакталган жок:", e);
      setSaved("error");
    }
  }, [key, single]);

  const latest = useRef(props);
  latest.current = props;
  const onUtterance = useCallback(async (clip: MocapClip) => {
    const p = latest.current;
    const c = p.recognizer.classifier;
    if (!c) return;
    setChecking(true);
    try {
      const target = p.target;
      // Бир сөз — checkSign; сүйлөм — checkSequence. Sync же async болушу мүмкүн — await экөөнө тең иштейт.
      let check: SequenceCheck;
      if (target.length === 1) {
        const x = await checkSign(c, clip, target[0]);
        check = { ...x, matched: [x.ok] };
      } else {
        check = await checkSequence(c, clip, target);
      }
      // Эч нерсе таанылган жок (бош кыймыл) — көңүл бурбайбыз
      if (!check.best && check.score === 0 && !check.matched.some(Boolean)) return;
      const r = { check, clip };
      setResult(r);
      setSaved("idle");
      p.onResult?.(r);
      if (check.ok && target.length === 1 && (p.autoSave ?? true)) void save(clip);
    } catch (e) {
      console.warn("[learn] текшерүү:", e);
    } finally {
      setChecking(false);
    }
  }, [save]);

  // Иштеп чыгууда гана: камерасыз текшерүү үчүн айтылышты колдон берүү (window.__learnSegment(clip))
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __learnSegment?: (c: MocapClip) => void };
    const f = (c: MocapClip) => void onUtterance(c);
    w.__learnSegment = f;
    return () => { if (w.__learnSegment === f) delete w.__learnSegment; };
  }, [onUtterance]);

  const pct = result ? Math.round(result.check.score * 100) : 0;
  const ok = result?.check.ok ?? false;
  const best = result?.check.best;
  const guess = single && best && best.gloss !== props.target[0] ? props.labelOf(best.gloss) : null;
  const hits = result ? result.check.matched.filter(Boolean).length : 0;

  return (
    <div className="ln-practice">
      <ol className="ln-instr">
        <li><span>{single ? "Жестти көрсөтүңүз" : "Бүт сүйлөмдү жест-жест менен көрсөтүңүз"}</span></li>
        <li><span>Бүткөндө <b>эки колуңузду ылдый түшүрүңүз</b> — ошондо текшерилет</span></li>
      </ol>
      <div className={`ln-duo ${props.side ? "two" : "one"}`}>
        {props.side && <div className="ln-duo-cell">{props.side}<span className="ln-duo-tag bottom">Аватар</span></div>}
        <div className="ln-duo-cell">
          <PracticeCamera on={props.cameraOn} setOn={props.setCameraOn} onUtterance={(c) => void onUtterance(c)} paused={!classifier || checking} checking={checking} hint={props.hint}>
            {props.cameraOn && !classifier && (
              <div className="stage-center"><span className="ln-pill"><span className="spinner" /> Таануу модели жүктөлүүдө…</span></div>
            )}
          </PracticeCamera>
          {props.side && <span className="ln-duo-tag">Сиз</span>}
        </div>
      </div>


      {result && (
        <div className={`ln-result ${ok ? "ok" : "bad"}`} role="status" aria-live="polite">
          <div className="ln-result-head">
            <span className="ln-result-ic">{ok ? <IconCheck /> : <IconX />}</span>
            <div className="ln-result-text">
              <b>{ok ? "Туура!" : single ? "Окшош эмес" : `${hits} / ${props.target.length} жест туура`}</b>
              <small>
                {ok
                  ? single ? (result.check.rank > 1 ? "Жакын — дагы бир аз тагыраак көрсөтсөңүз болот." : "Жест так таанылды.") : "Бүт сүйлөм туура көрсөтүлдү."
                  : single
                    ? guess ? <>Сиздин жест «<b>{guess}</b>» сыяктуу көрүндү.</> : "Жест таанылган жок — кайра аракет кылыңыз."
                    : "✗ белгиленген жесттерди аватардан карап, бүт сүйлөмдү кайра көрсөтүңүз."}
              </small>
            </div>
          </div>
          {!single && (
            <div className="ln-seq" aria-label="Сүйлөмдөгү жесттер">
              {props.target.map((g, i) => (
                <span key={`${g}-${i}`} className={`ln-seq-chip ${result.check.matched[i] ? "ok" : "bad"}`}>
                  {result.check.matched[i] ? <IconCheck /> : <IconX />} {props.labelOf(g)}
                </span>
              ))}
            </div>
          )}
          <div className="ln-sim" aria-label={`Окшоштук ${pct}%`}>
            <span>Окшоштук</span>
            <div className="ln-sim-bar"><i style={{ width: `${Math.max(3, pct)}%` }} /></div>
            <b>{pct}%</b>
          </div>
          {saved === "saved" && (
            <p className="ln-saved"><IconSave /> Сиздин жест эсте сакталды — бөлмөдө тезирээк таанылат.</p>
          )}
          {saved === "error" && <p className="ln-saved bad">Үлгү сакталган жок.</p>}
          <div className="ln-result-actions">
            <button className="btn" onClick={() => { setResult(null); setSaved("idle"); }}><IconReplay /> Кайра аракет</button>
            {single && !ok && saved === "idle" && (
              <button className="btn btn-ghost" onClick={() => void save(result.clip)} title="Таануу ката кетирди — бул жестти сиздин үлгүңүз катары сактоо">
                <IconSave /> Бул туура болчу — сактоо
              </button>
            )}
            {saved === "saving" && <span className="muted"><span className="spinner" style={{ verticalAlign: -3 }} /> Сакталууда…</span>}
          </div>
        </div>
      )}

      {count !== null && count > 0 && (
        <p className="ln-count muted">Бул жесттин сиздин үлгүлөрүңүз: <b>{count}</b> — таануу сизге ыңгайлашат.</p>
      )}
    </div>
  );
}
