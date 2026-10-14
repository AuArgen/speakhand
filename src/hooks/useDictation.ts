// Үзгүлтүксүз диктовка: Web Speech токтоп калса, колдонуучу өчүрмөйүнчө өзү кайра башталат.
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, sttSupported, type Listener } from "../lib/speech";

export interface Dictation {
  supported: boolean;
  listening: boolean;
  /** азырынча бүтпөгөн сөз */
  interim: string;
  error: string;
  start(): void;
  stop(): void;
  toggle(): void;
}

export function useDictation(opts: { lang: string; onFinal: (text: string) => void }): Dictation {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const want = useRef(false);
  const listener = useRef<Listener | null>(null);
  const restartTimer = useRef(0);
  const failures = useRef(0);
  /** Башталгандан кийин дароо токтой берсе (уруксат жок / кызмат жок) — чексиз кайра башталбайбыз */
  const startedAt = useRef(0);
  const rapidEnds = useRef(0);
  const onFinal = useRef(opts.onFinal);
  onFinal.current = opts.onFinal;
  const lang = useRef(opts.lang);

  const begin = useCallback(() => {
    const l = listen({
      lang: lang.current,
      onInterim: setInterim,
      onFinal: (t) => {
        failures.current = 0;
        setInterim("");
        if (t) onFinal.current(t);
      },
      onError: (msg) => {
        setError(msg);
        // Уруксат жок / браузер колдобойт — кайра аракет кылбайбыз
        if (/уруксат|браузер|микрофон табылган/i.test(msg)) want.current = false;
        else failures.current++;
      },
      onEnd: () => {
        listener.current = null;
        setInterim("");
        rapidEnds.current = Date.now() - startedAt.current < 1500 ? rapidEnds.current + 1 : 0;
        if (want.current && failures.current < 4 && rapidEnds.current < 3) {
          restartTimer.current = window.setTimeout(begin, 250);
        } else {
          if (want.current && rapidEnds.current >= 3) {
            setError((e) => e || "Үн таануу башталбай жатат. Микрофонго уруксат бериңиз же жазыңыз.");
          }
          want.current = false;
          rapidEnds.current = 0;
          setListening(false);
        }
      },
    });
    if (!l) {
      want.current = false;
      setListening(false);
      return;
    }
    startedAt.current = Date.now();
    listener.current = l;
    setListening(true);
  }, []);

  const start = useCallback(() => {
    if (want.current) return;
    setError("");
    failures.current = 0;
    want.current = true;
    begin();
  }, [begin]);

  const stop = useCallback(() => {
    want.current = false;
    window.clearTimeout(restartTimer.current);
    listener.current?.stop();
    listener.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const toggle = useCallback(() => (want.current ? stop() : start()), [start, stop]);

  // Тил өзгөрсө — угуп жатканда кайра башташ керек
  useEffect(() => {
    if (lang.current === opts.lang) return;
    lang.current = opts.lang;
    if (want.current) {
      listener.current?.stop();
    }
  }, [opts.lang]);

  useEffect(() => () => stop(), [stop]);

  return { supported: sttSupported(), listening, interim, error, start, stop, toggle };
}
