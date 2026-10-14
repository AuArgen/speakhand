// Үн/текст → жест тили (3D аватар).
import { useEffect, useRef, useState } from "react";
import { AvatarView, type AvatarHandle } from "../components/AvatarView";
import { IconInfo, IconMic, IconPlay, IconReplay, IconSparkle, IconStop } from "../components/icons";
import { translateToGloss, type ClaudeModel, type GlossMode, type GlossResponse } from "../lib/api";
import { buildSequence, type SequenceItem } from "../lib/sequence";
import { useStored } from "../lib/settings";
import { listen, sttSupported, type Listener } from "../lib/speech";
import { useDictionary } from "../lib/useDictionary";

const EXAMPLES = [
  "Саламатсызбы! Сиз кандайсыз?",
  "Рахмат, мен жакшымын",
  "Эртең досум менен үйгө барабыз",
  "Мага жардам бериңизчи",
  "Суу ичким келет",
];

export function TranslatePage(props: { theme: "dark" | "light"; model: ClaudeModel; claudeReady: boolean }) {
  const { signs } = useDictionary();
  const avatar = useRef<AvatarHandle>(null);
  const [text, setText] = useState("");
  const [interim, setInterim] = useState("");
  const [lang, setLang] = useStored<"ky-KG" | "ru-RU">("sttLang", "ky-KG");
  const [speed, setSpeed] = useStored("speed", 1);
  const [mode, setMode] = useStored<GlossMode>("glossMode", "auto");
  const [listening, setListening] = useState(false);
  const listener = useRef<Listener | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GlossResponse | null>(null);
  const [seq, setSeq] = useState<SequenceItem[]>([]);
  const [active, setActive] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => { listener.current?.stop(); abort.current?.abort(); }, []);

  async function play(items: SequenceItem[], from = 0) {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPlaying(true);
    try {
      await avatar.current?.play(items.slice(from), {
        speed,
        signal: ac.signal,
        onItemStart: (i) => setActive(from + i),
      });
    } finally {
      if (abort.current === ac) {
        setPlaying(false);
        setActive(-1);
      }
    }
  }

  function stop() {
    abort.current?.abort();
    avatar.current?.stop();
    setPlaying(false);
    setActive(-1);
  }

  async function translate(input = text) {
    const t = input.trim();
    if (!t || busy) return;
    stop();
    setBusy(true);
    setError("");
    try {
      const r = await translateToGloss(t, signs, { model: props.model, mode: props.claudeReady ? mode : "offline" });
      setResult(r);
      const s = await buildSequence(r.gloss, signs);
      setSeq(s);
      setBusy(false);
      await play(s);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  function toggleMic() {
    if (listening) {
      listener.current?.stop();
      return;
    }
    setError("");
    let finalText = "";
    const l = listen({
      lang,
      onInterim: setInterim,
      onFinal: (t) => {
        finalText = `${finalText} ${t}`.trim();
        setText(finalText);
      },
      onError: setError,
      onEnd: () => {
        setListening(false);
        setInterim("");
        listener.current = null;
        if (finalText) translate(finalText);
      },
    });
    if (l) {
      listener.current = l;
      setListening(true);
      setText("");
    }
  }

  const current = active >= 0 ? seq[active] : null;

  return (
    <div className="grid-2">
      <div className="stack">
        <AvatarView ref={avatar} theme={props.theme}>
          <div className="stage-overlay">
            <div className="stage-top">
              <span className="chip"><span className={`dot`} style={{ background: "var(--teal)" }} /> 3D котормочу</span>
              {result && (
                <span className="chip">
                  {ENGINE_LABEL[result.engine]}
                  {result.engine === "claude" ? ` · ${shortModel(result.model)}` : ""}
                  {result.ms ? ` · ${(result.ms / 1000).toFixed(1)} с` : ""}
                </span>
              )}
            </div>
            <div className={`caption ${current ? "" : "hidden"}`}>
              {current && (current.type === "fingerspell" ? <span className="fs">{current.gloss.split("").join("·")}</span> : current.gloss)}
            </div>
          </div>
        </AvatarView>

        <div className="card card-pad">
          <div className="card-head">
            <h2 className="card-title">Жест тизмеги</h2>
            <div className="row">
              <label className="switch" title="Ойнотуу ылдамдыгы">
                <span className="muted">Ылдамдык</span>
                <input className="range" type="range" min={0.5} max={1.5} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
                <span className="mono">{speed.toFixed(1)}×</span>
              </label>
              {playing ? (
                <button className="btn btn-sm" onClick={stop}><IconStop /> Токтотуу</button>
              ) : (
                <button className="btn btn-sm" disabled={!seq.length} onClick={() => play(seq)}><IconReplay /> Кайталоо</button>
              )}
            </div>
          </div>
          {seq.length ? (
            <div className="gloss-track">
              {seq.map((s, i) => (
                <button
                  key={i}
                  className={`gloss ${s.type === "fingerspell" ? "fs" : ""} ${s.type === "missing" ? "missing" : ""} ${i === active ? "active" : ""} ${playing && active > i ? "done" : ""}`}
                  title={s.type === "fingerspell" ? "Тамгалап көрсөтүлөт (сөздүктө жок)" : s.type === "missing" ? "Клип жок" : "Сөздүктөн"}
                  onClick={() => play(seq, i)}
                >
                  {s.type === "fingerspell" ? `✋ ${s.gloss}` : s.gloss}
                </button>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Котормо бул жерде жест тилинин тартибинде көрүнөт: убакыт → тема → аракет.</p>
          )}
          {result?.nonManual && (result.nonManual.question || result.nonManual.negation) && (
            <div className="row" style={{ marginTop: 12 }}>
              {result.nonManual.question && <span className="chip">❓ Суроо — каш көтөрүлөт</span>}
              {result.nonManual.negation && <span className="chip">↔ Тануу — баш чайкалат</span>}
            </div>
          )}
        </div>
      </div>

      <div className="stack">
        <div className="page-intro">
          <h1>Сүйлөңүз же жазыңыз — аватар жест менен көрсөтөт</h1>
          <p>Кыргызча сүйлөм жест тилинин грамматикасына которулат, анан 3D аватар аны көрсөтөт. Даяр жана мурун которулган сүйлөмдөр дароо чыгат — AI жаңы татаал сүйлөмдөр үчүн гана. Сөздүктө жок сөздөр тамгалап көрсөтүлөт.</p>
        </div>

        <div className="composer">
          <textarea
            value={listening ? `${text} ${interim}`.trim() : text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); translate(); }
            }}
            placeholder={listening ? "Угуп жатам…" : "Мисалы: Саламатсызбы, сиз кандайсыз?"}
            readOnly={listening}
            aria-label="Которула турган текст"
          />
          <div className="row">
            <button className={`mic ${listening ? "on" : ""}`} onClick={toggleMic} aria-label={listening ? "Угууну токтотуу" : "Сүйлөө"} disabled={!sttSupported()} title={sttSupported() ? "" : "Браузер үн тааныбайт"}>
              {listening ? <IconStop /> : <IconMic />}
            </button>
            <div className="seg" role="group" aria-label="Үн таануу тили">
              <button aria-pressed={lang === "ky-KG"} onClick={() => setLang("ky-KG")}>Кыргызча</button>
              <button aria-pressed={lang === "ru-RU"} onClick={() => setLang("ru-RU")}>Орусча</button>
            </div>
            <div className="spacer" />
            <button className="btn btn-primary" onClick={() => translate()} disabled={!text.trim() || busy || listening}>
              {busy ? <><span className="spinner" /> Которуп жатат…</> : <><IconPlay /> Көрсөтүү</>}
            </button>
          </div>
        </div>

        <div className="row" title={MODE_HINT[mode]}>
          <span className="muted">Котормо:</span>
          <div className="seg" role="group" aria-label="Котормо режими">
            <button aria-pressed={mode === "auto"} onClick={() => setMode("auto")}>Авто</button>
            <button aria-pressed={mode === "offline"} onClick={() => setMode("offline")}>AI'сыз</button>
            <button aria-pressed={mode === "ai"} onClick={() => setMode("ai")} disabled={!props.claudeReady}>Дайыма AI</button>
          </div>
          <span className="muted">{MODE_HINT[props.claudeReady ? mode : "offline"]}</span>
        </div>

        {error && <div className="notice error"><IconInfo /> {error}</div>}
        {result?.warning && <div className="notice"><IconInfo /> Claude жеткиликсиз болду, жөнөкөй эрежелер колдонулду: {result.warning}</div>}

        <div className="card card-pad">
          <h2 className="card-title" style={{ marginBottom: 12 }}><IconSparkle style={{ width: 14, verticalAlign: -2 }} /> Мисалдар</h2>
          <div className="suggestions">
            {EXAMPLES.map((e) => (
              <button key={e} className="suggestion" onClick={() => { setText(e); translate(e); }}>{e}</button>
            ))}
          </div>
        </div>

        <div className="notice">
          <IconInfo />
          <span>
            Демо жесттер болжолдуу — аларды жест тилин билген адам <b>Студияда</b> кайра жаздырышы керек. Ошондо аватар чыныгы адамдай кыймылдайт.
          </span>
        </div>
      </div>
    </div>
  );
}

const MODE_HINT: Record<GlossMode, string> = {
  auto: "Даяр жана сакталган котормолор дароо; жаңы татаал сүйлөм гана AI'га",
  offline: "Даяр котормолор + сөздүк эрежелери, интернет/AI керек эмес",
  ai: "Жаңы сүйлөмдөрдү дайыма AI которот (бир жолу которулганы сакталат)",
};

const ENGINE_LABEL: Record<GlossResponse["engine"], string> = {
  phrasebook: "⚡ Даяр котормо",
  cache: "⚡ Сакталган котормо",
  rules: "⚡ Сөздүк боюнча",
  claude: "Claude",
};

function shortModel(m?: string) {
  if (!m) return "";
  const x = m.match(/(opus|sonnet|haiku|fable)-?([\d-]*)/i);
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2].replace(/-\d{8}$/, "").replace(/-/g, ".")}`.trim() : m;
}
