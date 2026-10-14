// Сүйлөшүү тасмасы: менин билдирүүлөрүм / экинчи тараптын билдирүүлөрү, глосс чиптери, абал, убакыт.
import { useEffect, useRef, type ReactNode } from "react";
import type { ActivityStatus, Participant, Role } from "../../lib/room";
import type { TimelineItem } from "../../hooks/useRoom";
import { IconHand, IconMic, IconReplay, IconSpeaker } from "../icons";
import { IconBolt, IconCheck, IconClock, IconKeyboard } from "./roomIcons";

export const STATUS_TEXT: Record<ActivityStatus, string> = {
  idle: "",
  speaking: "сүйлөп жатат…",
  signing: "жест көрсөтүп жатат…",
  typing: "жазып жатат…",
};

const VIA_ICON = { voice: IconMic, sign: IconHand, text: IconKeyboard, quick: IconBolt } as const;
const VIA_TITLE = { voice: "Үн менен", sign: "Жест менен", text: "Жазылган", quick: "Даяр сүйлөм" } as const;

const fmtTime = (t: number) => new Date(t).toLocaleTimeString("ky-KG", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (t: number) => {
  const d = new Date(t), now = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return "Бүгүн";
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (same(d, y)) return "Кечээ";
  return d.toLocaleDateString("ky-KG", { day: "numeric", month: "long" });
};

export function Timeline(props: {
  items: TimelineItem[];
  partner: Participant | null;
  partnerStatus: ActivityStatus;
  viewerRole: Role;
  /** Келген билдирүүнү кайталоо (сүйлөөчүгө — үн, жаңсоочуга — аватар) */
  onReplay?: (item: TimelineItem) => void;
  /** Учурда аватар көрсөтүп жаткан билдирүү */
  activeId?: string | null;
  empty?: ReactNode;
  compact?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastCount = useRef(0);

  // Автоматтык жылдыруу: төмөндө турсак же өзүбүз жөнөткөн болсок
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const added = props.items.length > lastCount.current;
    lastCount.current = props.items.length;
    const last = props.items[props.items.length - 1];
    if (added && (stick.current || last?.mine)) {
      el.scrollTo({ top: el.scrollHeight, behavior: added && props.items.length > 1 ? "smooth" : "auto" });
    }
  }, [props.items, props.partnerStatus]);

  function onScroll() {
    const el = box.current!;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  const lastPartner = [...props.items].reverse().find((m) => !m.mine);
  const ReplayIcon = props.viewerRole === "speaker" ? IconSpeaker : IconReplay;
  const replayTitle = props.viewerRole === "speaker" ? "Кайра окуу" : "Аватарда кайра көрсөтүү";

  return (
    <div ref={box} className={`tl ${props.compact ? "compact" : ""}`} onScroll={onScroll} role="log" aria-label="Сүйлөшүү">
      {/* Экран окугучтар үчүн: эң акыркы келген билдирүү */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{lastPartner ? `${lastPartner.name || "Маектеш"}: ${lastPartner.text}` : ""}</div>

      {!props.items.length && props.empty}

      {props.items.map((m, i) => {
        const prev = props.items[i - 1];
        const newDay = !prev || fmtDay(prev.at) !== fmtDay(m.at);
        const grouped = prev && prev.from === m.from && m.at - prev.at < 90_000 && !newDay;
        const Via = VIA_ICON[m.via];
        return (
          <div key={m.id} className="tl-row-wrap">
            {newDay && <div className="tl-day"><span>{fmtDay(m.at)}</span></div>}
            <div className={`tl-row ${m.mine ? "mine" : "theirs"} ${grouped ? "grouped" : ""} ${m.pending ? "pending" : ""} ${props.activeId === m.id ? "active" : ""}`}>
              {!grouped && !m.mine && <div className="tl-name">{m.name || (m.role === "speaker" ? "Сүйлөөчү" : "Жаңсоочу")}</div>}
              <div className="tl-bubble">
                <div className="tl-text">{m.text}</div>
                {m.gloss && m.gloss.length > 0 && (m.via === "sign" || m.via === "quick") && (
                  <div className="tl-gloss" aria-label="Жест глосстору">{m.gloss.map((g, j) => <span key={j}>{g.replace(/^#/, "")}</span>)}</div>
                )}
                <div className="tl-meta">
                  <span className="tl-via" title={VIA_TITLE[m.via]} aria-label={VIA_TITLE[m.via]}><Via /></span>
                  <time dateTime={new Date(m.at).toISOString()}>{fmtTime(m.at)}</time>
                  {m.mine && (m.pending ? <IconClock className="tl-state" aria-label="Жөнөтүлүүдө" /> : <IconCheck className="tl-state ok" aria-label="Жөнөтүлдү" />)}
                </div>
              </div>
              {!m.mine && props.onReplay && (
                <button className="tl-replay" onClick={() => props.onReplay!(m)} aria-label={replayTitle} title={replayTitle}><ReplayIcon /></button>
              )}
            </div>
          </div>
        );
      })}

      {props.partnerStatus !== "idle" && props.partner && (
        <div className="tl-row theirs typing" aria-live="polite">
          <div className="tl-bubble tl-status">
            <span className="tl-dots"><i /><i /><i /></span>
            {props.partner.name || "Маектеш"} {STATUS_TEXT[props.partnerStatus]}
          </div>
        </div>
      )}
    </div>
  );
}
