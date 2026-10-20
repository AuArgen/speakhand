// Камера + MediaPipe көзөмөлү + скелет оверлейи. Ар бир кадрды onFrame аркылуу берет.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tracker, startCamera, stopCamera, drawOverlay, type TrackResult } from "../vision";

export function CameraView(props: {
  active: boolean;
  face?: boolean;
  onFrame?: (res: TrackResult) => void;
  children?: ReactNode;
  accent?: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const onFrame = useRef(props.onFrame);
  onFrame.current = props.onFrame;
  const tracker = useRef<Tracker | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "running" | "error">("idle");
  const [error, setError] = useState("");
  const [fps, setFps] = useState(0);

  useEffect(() => {
    if (!props.active) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    setStatus("loading");

    (async () => {
      try {
        const [t, s] = await Promise.all([Tracker.create({ face: props.face ?? false }), startCamera(video.current!)]);
        if (cancelled) { t.close(); stopCamera(s); return; }
        tracker.current = t;
        stream = s;
        setStatus("running");
        let frames = 0;
        let last = performance.now();
        let lastVideoTime = -1;
        let ctx: CanvasRenderingContext2D | null = null;
        const v0 = video.current!;
        // Жаңы видео кадры келгенде гана иштейбиз: requestVideoFrameCallback (болсо), болбосо rAF.
        const hasRvfc = "requestVideoFrameCallback" in v0;
        const schedule = (fn: () => void) => {
          if (hasRvfc) raf = (v0 as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => number }).requestVideoFrameCallback(fn);
          else raf = requestAnimationFrame(fn);
        };
        const loop = () => {
          if (cancelled) return;
          schedule(loop);
          const v = video.current;
          const c = canvas.current;
          if (!v || !c || v.readyState < 2 || v.currentTime === lastVideoTime) return;
          lastVideoTime = v.currentTime;
          const now = performance.now();
          const res = t.detect(v, now);
          const cw = Math.round(c.clientWidth * devicePixelRatio), ch = Math.round(c.clientHeight * devicePixelRatio);
          if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; ctx = null; }
          ctx ??= c.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, c.width, c.height);
            drawOverlay(ctx, res, { mirrored: true, width: c.width, height: c.height, accent: props.accent });
          }
          if (res) onFrame.current?.(res);
          frames++;
          if (now - last > 1000) { setFps(Math.round((frames * 1000) / (now - last))); frames = 0; last = now; }
        };
        loop();
      } catch (e) {
        if (cancelled) return;
        const msg = (e as Error).name === "NotAllowedError" ? "Камерага уруксат берилген жок" : (e as Error).message;
        setError(msg);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      const v = video.current as (HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void }) | null;
      v?.cancelVideoFrameCallback?.(raf);
      stopCamera(stream);
      tracker.current?.close();
      tracker.current = null;
      setStatus("idle");
    };
  }, [props.active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status === "running") tracker.current?.setFace(props.face ?? false);
  }, [props.face, status]);

  return (
    <div className="stage">
      <video ref={video} className="video-mirror" playsInline muted />
      <canvas ref={canvas} />
      <div className="stage-overlay">
        <div className="stage-top">
          <span className={`chip ${status === "running" ? "live" : status === "error" ? "bad" : ""}`}>
            <span className="dot" />
            {status === "running" ? `Түз эфир · ${fps} fps` : status === "loading" ? "Моделдер жүктөлүүдө…" : status === "error" ? "Ката" : "Камера өчүк"}
          </span>
        </div>
      </div>
      {status === "error" && (
        <div className="stage-center">
          <div className="notice error">{error}</div>
        </div>
      )}
      {props.children}
    </div>
  );
}
