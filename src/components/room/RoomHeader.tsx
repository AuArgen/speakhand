// Бөлмөнүн башы: код (басса көчүрүлөт), катышуучулар, чакыруу (QR), жөндөөлөр.
import { useState } from "react";
import type { ConnectionState, Participant, Role } from "../../lib/room";
import { IconHand, IconMic } from "../icons";
import { IconBack, IconChat, IconCheck, IconCopy, IconQr, IconSettings } from "./roomIcons";

export function RoomHeader(props: {
  code: string;
  participants: Participant[];
  meId: string | null;
  state: ConnectionState;
  onBack: () => void;
  onInvite: () => void;
  onSettings: () => void;
  onChat?: () => void;
  unread?: number;
  toast: (m: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.code);
      setCopied(true);
      props.toast("Код көчүрүлдү");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      props.toast(`Код: ${props.code}`);
    }
  }

  const others = props.participants.filter((p) => p.clientId !== props.meId);
  const me = props.participants.find((p) => p.clientId === props.meId);

  return (
    <header className="rm-head">
      <button className="rm-iconbtn" onClick={props.onBack} aria-label="Башкы бетке"><IconBack /></button>
      <button className={`rm-code ${copied ? "copied" : ""}`} onClick={copy} aria-label={`Бөлмөнүн коду ${props.code.split("").join(" ")}, көчүрүү`} title="Басып көчүрүңүз">
        <span className="rm-code-digits">{props.code.slice(0, 3)}<i /> {props.code.slice(3)}</span>
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      <div className="rm-people" aria-label="Катышуучулар">
        {me && <Person p={me} me />}
        {others.length ? others.map((p) => <Person key={p.clientId} p={p} />) : (
          <button className="rm-person waiting" onClick={props.onInvite}>
            <span className="rm-avatar"><span className="spinner" /></span>
            <span className="rm-person-text"><b>Күтүүдө…</b><small>чакыруу →</small></span>
          </button>
        )}
      </div>
      <div className="rm-head-actions">
        {props.onChat && (
          <button className="rm-iconbtn" onClick={props.onChat} aria-label="Сүйлөшүү тарыхы">
            <IconChat />
            {props.unread ? <span className="rm-badge">{props.unread > 9 ? "9+" : props.unread}</span> : null}
          </button>
        )}
        <button className="rm-iconbtn" onClick={props.onInvite} aria-label="Чакыруу: QR жана шилтеме"><IconQr /></button>
        <button className="rm-iconbtn" onClick={props.onSettings} aria-label="Жөндөөлөр"><IconSettings /></button>
      </div>
    </header>
  );
}

function Person({ p, me }: { p: Participant; me?: boolean }) {
  const Role = p.role === "speaker" ? IconMic : IconHand;
  return (
    <div className={`rm-person ${p.online ? "online" : "offline"} ${me ? "me" : ""}`} title={`${p.name || roleName(p.role)} — ${p.online ? "онлайн" : "офлайн"}`}>
      <span className={`rm-avatar ${p.role}`}><Role /><i className="rm-dot" /></span>
      <span className="rm-person-text">
        <b>{me ? "Сиз" : p.name || roleName(p.role)}</b>
        <small>{p.online ? roleName(p.role) : "офлайн"}</small>
      </span>
    </div>
  );
}

const roleName = (r: Role) => (r === "speaker" ? "сүйлөйт" : "жаңсайт");
