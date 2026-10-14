// 6 сандуу код: ар бир сан өз уячасында, автоматтык өтүү, чаптоо, телефондо сан клавиатурасы.
import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from "react";

export function CodeInput(props: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; disabled?: boolean; autoFocus?: boolean; invalid?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = props.value.replace(/\D/g, "").slice(0, 6);
  const { onComplete } = props;
  const completed = useRef("");

  useEffect(() => {
    if (digits.length === 6 && completed.current !== digits) {
      completed.current = digits;
      onComplete?.(digits);
    }
    if (digits.length < 6) completed.current = "";
  }, [digits, onComplete]);

  useEffect(() => {
    if (props.autoFocus) refs.current[0]?.focus();
  }, [props.autoFocus]);

  function set(next: string) {
    const v = next.replace(/\D/g, "").slice(0, 6);
    props.onChange(v);
    const focusIdx = Math.min(v.length, 5);
    refs.current[focusIdx]?.focus();
  }

  function onInput(i: number, raw: string) {
    const typed = raw.replace(/\D/g, "");
    if (!typed) {
      set(digits.slice(0, i) + digits.slice(i + 1));
      return;
    }
    // Бир нече сан келсе (автотолтуруу) — катары менен жайгаштырабыз
    set(digits.slice(0, i) + typed + digits.slice(i + typed.length));
  }

  function onKey(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace") {
      e.preventDefault();
      if (digits[i]) set(digits.slice(0, i) + digits.slice(i + 1));
      else if (i > 0) {
        set(digits.slice(0, i - 1) + digits.slice(i));
        refs.current[i - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < 5) refs.current[i + 1]?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    const found = text.match(/\d{6}/)?.[0] ?? text.replace(/\D/g, "");
    if (found) set(found);
  }

  return (
    <div className={`code-input ${props.invalid ? "invalid" : ""}`} role="group" aria-label="Бөлмөнүн 6 сандуу коду">
      {Array.from({ length: 6 }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className="code-cell"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={6}
          value={digits[i] ?? ""}
          onChange={(e) => onInput(i, e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={onPaste}
          onFocus={(e) => e.target.select()}
          disabled={props.disabled}
          aria-label={`${i + 1}-сан`}
        />
      ))}
    </div>
  );
}
