// Бүт тиркеме үчүн бир таануу модели (жест → глосс). AI колдонулбайт: DTW k-NN, браузерде.
// Модуль деңгээлиндеги жалгыз нуска (singleton):
//   • китепкананын алдын ала эсептелген үлгүлөрү (templates.bin) бир жолу жүктөлөт;
//   • колдонуучунун жаздыруулары (IndexedDB'деги entry.samples) кошулат жана сөздүк
//     өзгөргөндө кайра окутулат (банк сакталат — кайра эсептелбейт).
import { useEffect, useState } from "react";
import { loadTemplateBank } from "../data/library";
import { listSigns, onDictionaryChange } from "../data/store";
import { SignClassifier } from "../vision/classifier";

export interface RecognizerState {
  /** null — азырынча даяр эмес */
  classifier: SignClassifier | null;
  loading: boolean;
  /** Тааный турган глосстордун саны */
  vocabulary: number;
}

let state: RecognizerState = { classifier: null, loading: true, vocabulary: 0 };
const subs = new Set<(s: RecognizerState) => void>();
let started = false;

function publish(next: RecognizerState) {
  state = next;
  subs.forEach((f) => f(state));
}

function start() {
  if (started) return;
  started = true;
  void (async () => {
    const c = new SignClassifier();
    const bank = await loadTemplateBank();
    if (bank) {
      try {
        await c.addTemplatesAsync(bank);
      } catch (e) {
        console.warn("[recognizer] банк кошулган жок:", e);
      }
    }
    let seq = 0;
    const train = async () => {
      const my = ++seq;
      const signs = await listSigns();
      if (my !== seq) return;
      c.train(signs.filter((s) => s.source !== "library"));
      publish({ classifier: c, loading: false, vocabulary: c.vocabulary.length });
    };
    onDictionaryChange(() => void train());
    await train();
  })().catch((e) => {
    console.warn("[recognizer] даярдалган жок:", e);
    publish({ classifier: null, loading: false, vocabulary: 0 });
  });
}

/** Жалгыз таануу моделин алдын ала даярдоо (мис. бөлмөгө киргенде). */
export function warmUpRecognizer(): void {
  start();
}

/**
 * @param enabled false болсо — модель жүктөлбөйт (мис. сүйлөөчүнүн түзмөгүнө 2.5 МБ үлгүлөр керек эмес).
 */
export function useRecognizer(enabled = true): RecognizerState {
  const [s, setS] = useState(state);
  useEffect(() => {
    if (!enabled) return;
    start();
    subs.add(setS);
    setS(state);
    return () => {
      subs.delete(setS);
    };
  }, [enabled]);
  return s;
}
