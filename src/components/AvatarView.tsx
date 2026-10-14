// AvatarStage (three.js) үчүн React ороочу.
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { AvatarStage, type PlayItem, type PlayOptions } from "../avatar";
import type { MocapFrame } from "../lib/types";

export interface AvatarHandle {
  play(items: PlayItem[], opts?: PlayOptions): Promise<void>;
  stop(): void;
  setLiveFrame(frame: MocapFrame | null): void;
}

export function AvatarView(props: { theme: "dark" | "light"; children?: ReactNode; ref?: Ref<AvatarHandle>; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<AvatarStage | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    let s: AvatarStage;
    try {
      s = new AvatarStage(host.current, { background: "transparent" });
    } catch (e) {
      setError(`3D көрсөтүү иштебей жатат: ${(e as Error).message}`);
      return;
    }
    stage.current = s;
    s.ready.then(() => setReady(true)).catch((e) => setError(String(e)));
    return () => {
      s.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => stage.current?.setTheme(props.theme), [props.theme, ready]);

  useImperativeHandle(props.ref, () => ({
    play: (items, opts) => stage.current?.play(items, opts) ?? Promise.resolve(),
    stop: () => stage.current?.stop(),
    setLiveFrame: (f) => stage.current?.setLiveFrame(f),
  }));

  return (
    <div className={`stage ${props.className ?? ""}`}>
      <div ref={host} className="stage-canvas" />
      {!ready && !error && (
        <div className="stage-center">
          <span className="chip"><span className="spinner" /> Аватар жүктөлүүдө…</span>
        </div>
      )}
      {error && (
        <div className="stage-center">
          <div className="notice error">{error}</div>
        </div>
      )}
      {props.children}
    </div>
  );
}
