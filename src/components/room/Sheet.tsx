// Төмөнкү барак (телефон) / диалог (чоң экран). Escape жана фонго басуу жабат.
import { useEffect, useRef, type ReactNode } from "react";
import { IconX } from "../icons";

export function Sheet(props: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean; tall?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // фокусту баракка
    const t = window.setTimeout(() => panel.current?.querySelector<HTMLElement>("input, button, [tabindex]")?.focus(), 50);
    return () => {
      removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-root" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} className={`sheet ${props.wide ? "wide" : ""} ${props.tall ? "tall" : ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="sheet-grab" aria-hidden />
        <div className="sheet-head">
          <h2 className="sheet-title">{props.title}</h2>
          <button className="btn btn-icon btn-ghost" onClick={onClose} aria-label="Жабуу"><IconX /></button>
        </div>
        <div className="sheet-body">{props.children}</div>
      </div>
    </div>
  );
}
