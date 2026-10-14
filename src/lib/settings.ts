// Колдонуучунун жөндөөлөрү — localStorage'та (ар бир браузерде өзүнчө).
import { useEffect, useState } from "react";

export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`speak:${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`speak:${key}`, JSON.stringify(value));
    } catch {
      /* жеке режим — маанилүү эмес */
    }
  }, [key, value]);
  return [value, setValue];
}
