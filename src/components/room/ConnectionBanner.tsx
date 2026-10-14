// Байланыш абалы: туташууда / кайра туташууда / жабык / ката.
import type { ConnectionState } from "../../lib/room";
import type { RoomError } from "../../hooks/useRoom";
import { IconReplay } from "../icons";
import { IconHome, IconWifiOff } from "./roomIcons";

const ERROR_TEXT: Record<string, string> = {
  not_found: "Мындай бөлмө жок. Кодду текшериңиз.",
  room_full: "Бөлмө толук — бул роль менен башка адам кирип турат.",
  rate_limited: "Өтө көп билдирүү. Бир аз күтө туруңуз.",
  bad_request: "Сурам туура эмес.",
};

export function ConnectionBanner(props: { state: ConnectionState; error: RoomError | null; welcomed: boolean; onRetry: () => void; onHome: () => void }) {
  const fatal = props.error && (props.error.code === "not_found" || props.error.code === "room_full");
  if (fatal) {
    return (
      <div className="rm-banner error" role="alert">
        <IconWifiOff />
        <span>{ERROR_TEXT[props.error!.code] ?? props.error!.message}</span>
        <button className="btn btn-sm" onClick={props.onHome}><IconHome /> Башкы бет</button>
      </div>
    );
  }
  if (props.state === "open") {
    return props.error ? (
      <div className="rm-banner warn" role="status"><span>{ERROR_TEXT[props.error.code] ?? props.error.message}</span></div>
    ) : null;
  }
  if (props.state === "connecting" && !props.welcomed) {
    return <div className="rm-banner" role="status"><span className="spinner" /> Бөлмөгө туташууда…</div>;
  }
  if (props.state === "closed") {
    return (
      <div className="rm-banner warn" role="status">
        <IconWifiOff /> <span>Байланыш жабылды.</span>
        <button className="btn btn-sm" onClick={props.onRetry}><IconReplay /> Кайра туташуу</button>
      </div>
    );
  }
  return (
    <div className="rm-banner warn" role="status">
      <span className="spinner" /> Байланыш үзүлдү — кайра туташууда… Билдирүүлөр кезекке коюлат.
    </div>
  );
}
