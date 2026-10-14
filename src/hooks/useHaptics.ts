// Дүлөй колдонуучу үчүн үндүн ордуна: вибрация + экрандын жаркылдашы.
import { useCallback, useEffect, useRef, useState } from "react";

export function vibrate(pattern: number | number[] = [70, 40, 70]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* колдоого алынбайт */
  }
}

/** Жаркылдоо абалы: trigger() → 700 мс бою true. */
export function useFlash(ms = 700): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  const trigger = useCallback(() => {
    setOn(false);
    window.clearTimeout(timer.current);
    // кийинки кадрда күйгүзүү — анимация кайра башталсын
    requestAnimationFrame(() => {
      setOn(true);
      timer.current = window.setTimeout(() => setOn(false), ms);
    });
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [on, trigger];
}

/** Терезе көрүнбөй турганда аталышты жаркылдатуу (жаңы билдирүү). */
export function useTitleBlink(count: number, base = "Сүйлө") {
  useEffect(() => {
    if (!count || document.visibilityState === "visible") {
      document.title = base;
      return;
    }
    let on = false;
    const id = window.setInterval(() => {
      on = !on;
      document.title = on ? `(${count}) Жаңы билдирүү — ${base}` : base;
    }, 1200);
    const stop = () => {
      window.clearInterval(id);
      document.title = base;
    };
    document.addEventListener("visibilitychange", stop, { once: true });
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", stop);
      document.title = base;
    };
  }, [count, base]);
}
