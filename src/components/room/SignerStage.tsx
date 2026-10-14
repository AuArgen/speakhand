// Жаңсоочунун сахнасы: 3D аватар ар бир келген билдирүүнү жест менен көрсөтөт; кезек; чоң субтитр.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ClaudeModel, GlossMode } from "../../lib/api";
import { translateToGloss } from "../../lib/api";
import { buildSequence, type SequenceItem } from "../../lib/sequence";
import type { SignEntry } from "../../lib/types";
import type { TimelineItem } from "../../hooks/useRoom";
import { AvatarView, type AvatarHandle } from "../AvatarView";
import { IconSkip } from "./roomIcons";

export interface SignerStageHandle {
  enqueue(m: TimelineItem): void;
  /** Кезектин башына коюп, учурдагыны токтотот */
  replay(m: TimelineItem): void;
  skip(): void;
}

interface Current {
  item: TimelineItem;
  seq: SequenceItem[];
  idx: number;
  phase: "translating" | "playing";
}

export function SignerStage(props: {
  theme: "dark" | "light";
  speed: number;
  signs: SignEntry[];
  glossMode: GlossMode;
  model: ClaudeModel;
  flash: boolean;
  onActive?: (id: string | null) => void;
  lastText?: string;
  ref?: Ref<SignerStageHandle>;
}) {
  const avatar = useRef<AvatarHandle>(null);
  const [queue, setQueue] = useState<TimelineItem[]>([]);
  const [cur, setCur] = useState<Current | null>(null);
  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const signs = useRef(props.signs);
  signs.current = props.signs;
  const speed = useRef(props.speed);
  speed.current = props.speed;
  const opts = useRef({ mode: props.glossMode, model: props.model });
  opts.current = { mode: props.glossMode, model: props.model };
  const onActive = useRef(props.onActive);
  onActive.current = props.onActive;
  const glossCache = useRef(new Map<string, string[]>());

  const stopCurrent = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    avatar.current?.stop();
  }, []);

  useImperativeHandle(props.ref, () => ({
    enqueue: (m) => setQueue((q) => (q.some((x) => x.id === m.id) ? q : [...q, m])),
    replay: (m) => {
      stopCurrent();
      setQueue((q) => [m, ...q.filter((x) => x.id !== m.id)]);
    },
    skip: () => stopCurrent(),
  }));

  // Кезекти иштетүү: бирден, катары менен
  useEffect(() => {
    if (busy.current || !queue.length) return;
    const item = queue[0];
    busy.current = true;
    setQueue((q) => q.slice(1));
    const ac = new AbortController();
    abort.current = ac;
    setCur({ item, seq: [], idx: -1, phase: "translating" });
    onActive.current?.(item.id);

    (async () => {
      let gloss: string[];
      try {
        gloss = await glossFor(item, signs.current, opts.current, glossCache.current, ac.signal);
      } catch {
        gloss = fallbackGloss(item.text);
      }
      if (ac.signal.aborted) return;
      const seq = await buildSequence(gloss, signs.current);
      if (ac.signal.aborted) return;
      setCur({ item, seq, idx: 0, phase: "playing" });
      await avatar.current?.play(seq, {
        speed: speed.current,
        signal: ac.signal,
        onItemStart: (i) => setCur((c) => (c && c.item.id === item.id ? { ...c, idx: i } : c)),
      });
    })()
      .catch(() => {})
      .finally(() => {
        busy.current = false;
        if (abort.current === ac) abort.current = null;
        setCur((c) => (c && c.item.id === item.id ? null : c));
        onActive.current?.(null);
        // кийинкиге өтүү
        setQueue((q) => [...q]);
      });
  }, [queue]);

  useEffect(() => () => stopCurrent(), [stopCurrent]);

  const active = cur && cur.idx >= 0 ? cur.seq[cur.idx] : null;
  const shown = cur?.item.text ?? props.lastText ?? "";

  return (
    <div className={`rm-stage ${props.flash ? "flash" : ""} ${cur ? "busy" : "idle"}`}>
      <AvatarView ref={avatar} theme={props.theme} className="rm-avatar-stage">
        <div className="rm-stage-overlay">
          <div className={`rm-caption ${cur ? "live" : ""} ${shown.length > 60 ? "long" : ""}`} aria-live="off">
            {shown || <span className="rm-caption-hint">Маектеш сүйлөгөндө сөзү ушул жерде чыгып, аватар жест менен көрсөтөт</span>}
          </div>
          <div className="rm-stage-bottom">
            <div className="rm-stage-state">
              {cur?.phase === "translating" && <span className="chip"><span className="spinner" /> Которулуп жатат…</span>}
              {cur?.phase === "playing" && active && (
                <span className={`chip ${active.type === "fingerspell" ? "rec" : active.type === "missing" ? "" : "demo"}`}>
                  {active.type === "fingerspell" ? `✋ ${active.gloss.split("").join("·")}` : active.gloss}
                  {cur.seq.length > 1 ? ` · ${cur.idx + 1}/${cur.seq.length}` : ""}
                </span>
              )}
              {queue.length > 0 && <span className="chip warn"><span className="dot" /> Кезекте {queue.length}</span>}
            </div>
            {cur && (
              <button className="btn btn-sm rm-skip" onClick={stopCurrent} aria-label="Өткөрүп жиберүү"><IconSkip /> Өткөрүү</button>
            )}
          </div>
        </div>
      </AvatarView>
      <div className="rm-flash" aria-hidden />
    </div>
  );
}

async function glossFor(
  item: TimelineItem,
  signs: SignEntry[],
  o: { mode: GlossMode; model: ClaudeModel },
  cache: Map<string, string[]>,
  signal: AbortSignal,
): Promise<string[]> {
  if (item.gloss && item.gloss.length) return item.gloss;
  const key = `${o.mode}:${item.text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = await translateToGloss(item.text, signs, { model: o.model, mode: o.mode, signal });
  const gloss = r.gloss.length ? r.gloss : fallbackGloss(item.text);
  cache.set(key, gloss);
  return gloss;
}

/** Сервер жок болсо: сөздөрдү чоң тамга менен — сөздүктө болсо жест, болбосо тамгалап. */
function fallbackGloss(text: string): string[] {
  return text
    .replace(/[.,!?;:«»"()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLocaleUpperCase("ky-KG"));
}
