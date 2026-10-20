// Аватар жестти (же сүйлөмдү жест-жест) кайра-кайра көрсөтөт: ылдамдык 0.5×/1×, кайталоо, токтотуу.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { buildSequence, type SequenceItem } from "../../lib/sequence";
import type { SignEntry } from "../../lib/types";
import { AvatarView, type AvatarHandle } from "../AvatarView";
import { IconReplay } from "../icons";
import { IconLoop } from "./learnIcons";

export type Speed = 0.5 | 1;

export function SignPlayer(props: {
  theme: "dark" | "light";
  /** Ойното турган глосстор; өзгөргөндө кайрадан башталат */
  gloss: string[];
  signs: SignEntry[];
  speed: Speed;
  onSpeed?: (s: Speed) => void;
  /** Кайра-кайра ойнотуу (демейки true) */
  loop?: boolean;
  onLoop?: (v: boolean) => void;
  /** false — ойнотпой турат (мис. тест жооп күтүп жатканда эмес, жашыруу үчүн) */
  playing?: boolean;
  /** Учурда ойноп жаткан глосстун индекси (-1 — тыныгуу) */
  onActive?: (i: number) => void;
  /** Ушул сан өзгөргөндө башынан кайра ойнотот */
  replayToken?: number;
  /** Үстүнкү оң бурчтагы башкаруу баскычтарын жашыруу */
  bare?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const avatar = useRef<AvatarHandle>(null);
  const signs = useRef(props.signs);
  signs.current = props.signs;
  const onActive = useRef(props.onActive);
  onActive.current = props.onActive;
  const [state, setState] = useState<"loading" | "playing" | "pause" | "missing">("loading");
  const [token, setToken] = useState(0);
  const key = props.gloss.join("\u0001");
  const loop = props.loop ?? true;
  const playing = props.playing ?? true;
  // Сөздүк кеч жүктөлсө (клип табылбай калса) — бир жолу кайра аракет
  const hasSigns = props.signs.length > 0;

  useEffect(() => {
    if (!playing || !key) return;
    const ac = new AbortController();
    const { signal } = ac;
    let seq: SequenceItem[] = [];
    (async () => {
      setState("loading");
      seq = await buildSequence(key.split("\u0001"), signs.current);
      if (signal.aborted) return;
      if (!seq.some((s) => s.clip)) { setState("missing"); return; }
      // Аватар даяр болгуча бир аз күтөбүз (биринчи ачылганда)
      await wait(250, signal);
      do {
        if (signal.aborted) return;
        setState("playing");
        await avatar.current?.play(seq, { speed: props.speed, signal, onItemStart: (i) => onActive.current?.(i) });
        if (signal.aborted) return;
        onActive.current?.(-1);
        setState("pause");
        await wait(loop ? 1100 : 0, signal);
      } while (loop && !signal.aborted);
    })().catch((e) => console.warn("[learn] ойнотуу:", e));
    return () => {
      ac.abort();
      onActive.current?.(-1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, props.speed, loop, playing, token, props.replayToken, hasSigns]);

  return (
    <AvatarView ref={avatar} theme={props.theme} className={`ln-avatar ${props.className ?? ""}`}>
      {!props.bare && (
        <div className="ln-player-ctl">
          <div className="ln-speed" role="group" aria-label="Ылдамдык">
            {([0.5, 1] as Speed[]).map((s) => (
              <button key={s} aria-pressed={props.speed === s} onClick={() => props.onSpeed?.(s)} title={s === 0.5 ? "Жай" : "Кадимки"}>{s === 0.5 ? "0.5×" : "1×"}</button>
            ))}
          </div>
          {props.onLoop && (
            <button className={`ln-ctl-btn ${loop ? "on" : ""}`} aria-pressed={loop} onClick={() => props.onLoop?.(!loop)} title="Кайра-кайра көрсөтүү" aria-label="Кайра-кайра көрсөтүү"><IconLoop /></button>
          )}
          <button className="ln-ctl-btn" onClick={() => setToken((t) => t + 1)} title="Кайра көрсөтүү" aria-label="Кайра көрсөтүү"><IconReplay /></button>
        </div>
      )}
      {state === "missing" && (
        <div className="stage-center"><div className="notice">Бул жесттин анимациясы азырынча жок</div></div>
      )}
      {props.children}
    </AvatarView>
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(t); resolve(); }, { once: true });
  });
}
