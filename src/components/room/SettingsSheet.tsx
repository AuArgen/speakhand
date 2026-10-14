// Бөлмөнүн жөндөөлөрү: үн, аватар ылдамдыгы, AI, үн таануу тили, вибрация, тема, роль, чыгуу.
import type { Role } from "../../lib/room";
import { IconMoon, IconSun } from "../icons";
import { IconLogout, IconSwap } from "./roomIcons";
import { ROLE_LABEL } from "./RoleCards";
import type { RoomSettingsHook } from "./settings";
import { Sheet } from "./Sheet";

export function SettingsSheet(props: {
  open: boolean;
  onClose: () => void;
  role: Role;
  settings: RoomSettingsHook;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  claudeReady: boolean;
  onChangeRole: () => void;
  onLeave: () => void;
}) {
  const { s, set } = props.settings;
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Жөндөөлөр">
      <div className="settings">
        <section>
          <h3>Сиздин роль</h3>
          <div className="settings-row">
            <div><b>{ROLE_LABEL[props.role]}</b><small>{props.role === "speaker" ? "Сиз сүйлөйсүз, маектеш жест менен көрөт" : "Сиз жаңсайсыз, маектеш угат"}</small></div>
            <button className="btn btn-sm" onClick={props.onChangeRole}><IconSwap /> Өзгөртүү</button>
          </div>
        </section>

        <section>
          <h3>Келген билдирүүлөр</h3>
          <label className="settings-row">
            <div><b>Үн менен окуу</b><small>Жаңсоочунун сөзү автоматтык түрдө окулат</small></div>
            <span className="switch"><input type="checkbox" checked={s.tts} onChange={(e) => set("tts", e.target.checked)} /></span>
          </label>
          <label className="settings-row">
            <div><b>Вибрация</b><small>Жаңы билдирүүдө телефон титирейт, экран жаркылдайт</small></div>
            <span className="switch"><input type="checkbox" checked={s.vibrate} onChange={(e) => set("vibrate", e.target.checked)} /></span>
          </label>
          <label className="settings-row">
            <div><b>Аватардын ылдамдыгы</b><small>{s.speed.toFixed(1)}× — жайыраак көрүү үчүн азайтыңыз</small></div>
            <input className="range" type="range" min={0.5} max={1.5} step={0.1} value={s.speed} onChange={(e) => set("speed", Number(e.target.value))} aria-label="Аватардын ылдамдыгы" />
          </label>
        </section>

        <section>
          <h3>Котормо</h3>
          <label className="settings-row">
            <div><b>AI котормосуна уруксат</b><small>{props.claudeReady ? "Жаңы татаал сүйлөмдөрдү Claude которот (жайыраак). Өчүк болсо — даяр сүйлөмдөр жана сөздүк эрежелери, дароо." : "Claude CLI табылган жок — AI'сыз режим"}</small></div>
            <span className="switch"><input type="checkbox" checked={s.ai && props.claudeReady} disabled={!props.claudeReady} onChange={(e) => set("ai", e.target.checked)} /></span>
          </label>
          <div className="settings-row">
            <div><b>Үн таануу тили</b><small>Браузер кыргызчаны тааныбаса — орусчаны тандаңыз</small></div>
            <div className="seg" role="group" aria-label="Үн таануу тили">
              <button aria-pressed={s.sttLang === "ky-KG"} onClick={() => set("sttLang", "ky-KG")}>Кыргызча</button>
              <button aria-pressed={s.sttLang === "ru-RU"} onClick={() => set("sttLang", "ru-RU")}>Орусча</button>
            </div>
          </div>
        </section>

        <section>
          <h3>Жест таануу</h3>
          <label className="settings-row">
            <div><b>Ишеним босогосу</b><small>{Math.round(s.threshold * 100)}% — төмөн болсо көбүрөөк кабыл алат, ката да көбөйөт</small></div>
            <input className="range" type="range" min={0.3} max={0.9} step={0.05} value={s.threshold} onChange={(e) => set("threshold", Number(e.target.value))} aria-label="Ишеним босогосу" />
          </label>
          <label className="settings-row">
            <div><b>Автоматтык жөнөтүү</b><small>Жест токтогондон {(s.autoSendMs / 1000).toFixed(1)} с кийин сүйлөм жөнөтүлөт</small></div>
            <input className="range" type="range" min={1500} max={5000} step={250} value={s.autoSendMs} onChange={(e) => set("autoSendMs", Number(e.target.value))} aria-label="Автоматтык жөнөтүү убактысы" />
          </label>
        </section>

        <section>
          <h3>Көрүнүш</h3>
          <div className="settings-row">
            <div><b>Тема</b><small>Караңгы же жарык</small></div>
            <div className="seg" role="group" aria-label="Тема">
              <button aria-pressed={props.theme === "dark"} onClick={() => props.setTheme("dark")}><IconMoon style={{ width: 15, verticalAlign: -3 }} /> Караңгы</button>
              <button aria-pressed={props.theme === "light"} onClick={() => props.setTheme("light")}><IconSun style={{ width: 15, verticalAlign: -3 }} /> Жарык</button>
            </div>
          </div>
        </section>

        <button className="btn btn-danger" style={{ width: "100%" }} onClick={props.onLeave}><IconLogout /> Бөлмөдөн чыгуу</button>
      </div>
    </Sheet>
  );
}
