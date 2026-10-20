// Прогресс айланасы (0..1) — ортосуна текст/иконка салса болот.
import type { ReactNode } from "react";

export function Ring(props: { value: number; size?: number; stroke?: number; tone?: "accent" | "teal" | "ok"; children?: ReactNode; label?: string }) {
  const size = props.size ?? 44;
  const sw = props.stroke ?? 4;
  const r = (size - sw) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, props.value));
  return (
    <span className={`ln-ring ${props.tone ?? "accent"}`} style={{ width: size, height: size }} role="img" aria-label={props.label ?? `${Math.round(v * 100)}%`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={sw} className="ln-ring-bg" />
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={sw} className="ln-ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - v)} />
      </svg>
      {props.children !== undefined && <span className="ln-ring-in">{props.children}</span>}
    </span>
  );
}
