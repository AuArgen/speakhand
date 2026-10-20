// Бөлмөнүн жөндөөлөрү — localStorage (useStored). Ар бир түзмөкте өзүнчө.
import type { GlossMode } from "../../lib/api";
import { useStored } from "../../lib/settings";

export type SttLang = "ky-KG" | "ru-RU";

export interface RoomSettings {
  /** Келген билдирүүлөрдү үн менен окуу (сүйлөөчү тарап) */
  tts: boolean;
  /** Аватардын ылдамдыгы */
  speed: number;
  /** AI котормосуна уруксат (auto); өчүк болсо — offline, дароо */
  ai: boolean;
  sttLang: SttLang;
  /** Жаңы билдирүүдө вибрация */
  vibrate: boolean;
  /** Жест таануу ишеним босогосу */
  threshold: number;
  /** Жест токтогондон кийин автоматтык жөнөтүүгө чейин, мс */
  autoSendMs: number;
}

export interface RoomSettingsHook {
  s: RoomSettings;
  set<K extends keyof RoomSettings>(key: K, value: RoomSettings[K]): void;
  glossMode: GlossMode;
}

export function useRoomSettings(): RoomSettingsHook {
  const [tts, setTts] = useStored("roomTts", true);
  const [speed, setSpeed] = useStored("speed", 1);
  const [ai, setAi] = useStored("roomAi", false);
  const [sttLang, setSttLang] = useStored<SttLang>("sttLang", "ky-KG");
  const [vibrate, setVibrate] = useStored("roomVibrate", true);
  // (recThreshold2: четке кагуу калибровкасы өзгөрдү — эски сакталган маани колдонулбайт)
  const [threshold, setThreshold] = useStored("recThreshold2", 0.45);
  const [autoSendMs, setAutoSendMs] = useStored("roomAutoSendMs", 2500);
  const s: RoomSettings = { tts, speed, ai, sttLang, vibrate, threshold, autoSendMs };
  const setters: { [K in keyof RoomSettings]: (v: RoomSettings[K]) => void } = {
    tts: setTts,
    speed: setSpeed,
    ai: setAi,
    sttLang: setSttLang,
    vibrate: setVibrate,
    threshold: setThreshold,
    autoSendMs: setAutoSendMs,
  };
  return {
    s,
    set: (key, value) => (setters[key] as (v: typeof value) => void)(value),
    glossMode: ai ? "auto" : "offline",
  };
}
