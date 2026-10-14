// Сүйлөөчүнүн куралы: чоң микрофон (үзгүлтүксүз диктовка, ар бир бүткөн сүйлөм дароо жөнөтүлөт),
// текст жазуу, даяр сүйлөмдөр баскычы.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { RoomHook } from "../../hooks/useRoom";
import { useDictation } from "../../hooks/useDictation";
import { IconInfo, IconMic, IconStop } from "../icons";
import { IconBolt, IconSend } from "./roomIcons";
import type { SttLang } from "./settings";

export function SpeakerComposer(props: {
  send: RoomHook["send"];
  setStatus: RoomHook["setStatus"];
  sttLang: SttLang;
  onOpenPhrases?: () => void;
  disabled?: boolean;
  wide?: boolean;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef(0);
  const { send, setStatus } = props;

  const dict = useDictation({
    lang: props.sttLang,
    onFinal: (t) => send(t, { via: "voice" }),
  });

  // Абал: сүйлөп жатат / жазып жатат
  useEffect(() => {
    if (dict.listening) setStatus("speaking");
    else if (!text.trim()) setStatus("idle");
  }, [dict.listening, text, setStatus]);

  function onType(v: string) {
    setText(v);
    if (dict.listening) return;
    if (v.trim()) {
      setStatus("typing");
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => setStatus("idle"), 3000);
    } else setStatus("idle");
    // автоматтык бийиктик
    const el = area.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }
  }

  function submit() {
    const t = text.trim();
    if (!t) return;
    send(t, { via: "text" });
    setText("");
    window.clearTimeout(typingTimer.current);
    if (area.current) area.current.style.height = "";
    area.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  useEffect(() => () => window.clearTimeout(typingTimer.current), []);

  const micLabel = dict.listening ? "Угуп жатам — токтотуу үчүн басыңыз" : dict.supported ? "Сүйлөө үчүн басыңыз" : "Бул браузер үн тааныбайт";

  return (
    <div className={`cmp ${dict.listening ? "listening" : ""} ${props.wide ? "wide" : ""}`}>
      {(dict.listening || dict.interim) && (
        <div className="cmp-live" aria-live="polite">
          <span className="cmp-live-dot" />
          {dict.interim ? <span className="cmp-interim">{dict.interim}</span> : <span className="muted">Угуп жатам… сүйлөңүз, ар бир сүйлөм дароо жөнөтүлөт</span>}
        </div>
      )}
      {dict.error && !dict.listening && (
        <div className="notice error cmp-error"><IconInfo /> {dict.error}</div>
      )}
      <div className="cmp-row">
        <button className={`mic cmp-mic ${dict.listening ? "on" : ""}`} onClick={dict.toggle} disabled={!dict.supported || props.disabled} aria-label={micLabel} aria-pressed={dict.listening} title={micLabel}>
          {dict.listening ? <IconStop /> : <IconMic />}
        </button>
        {props.onOpenPhrases && (
          <button className="rm-iconbtn cmp-quick" onClick={props.onOpenPhrases} aria-label="Даяр сүйлөмдөр" title="Даяр сүйлөмдөр"><IconBolt /></button>
        )}
        <textarea
          ref={area}
          className="cmp-input"
          rows={1}
          value={text}
          onChange={(e) => onType(e.target.value)}
          onKeyDown={onKey}
          placeholder={dict.listening ? "Же жазыңыз…" : "Жазыңыз…"}
          aria-label="Билдирүү жазуу"
          enterKeyHint="send"
          disabled={props.disabled}
        />
        <button className="btn btn-primary btn-icon cmp-send" onClick={submit} disabled={!text.trim() || props.disabled} aria-label="Жөнөтүү"><IconSend /></button>
      </div>
      <div className="cmp-hint" aria-hidden>{dict.listening ? "Токтотуу үчүн микрофонду басыңыз" : dict.supported ? "Микрофонду басып сүйлөңүз — же жазыңыз" : "Үн таануу жок: жазыңыз же даяр сүйлөмдөрдү колдонуңуз"}</div>
    </div>
  );
}
