// Үн → текст (Web Speech API) жана текст → үн.
import { fetchKyrgyzSpeech } from "./api";

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionCtor(): (new () => RecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const sttSupported = () => getRecognitionCtor() !== null;

export interface Listener {
  stop(): void;
}

const STT_ERRORS: Record<string, string> = {
  "not-allowed": "Микрофонго уруксат берилген жок",
  "no-speech": "Үн угулган жок",
  "network": "Тармак катасы (Chrome үн таануу интернет талап кылат)",
  "language-not-supported": "Бул браузер кыргызча үн тааныбайт — орусча режимди тандаңыз",
  "audio-capture": "Микрофон табылган жок",
};

/** Сүйлөөнү угуу. lang: "ky-KG" (кыргызча) же "ru-RU" (запас). */
export function listen(opts: {
  lang: string;
  onInterim: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (msg: string) => void;
  onEnd: () => void;
}): Listener | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    opts.onError("Бул браузер үн тааныбайт. Chrome же Edge колдонуңуз.");
    return null;
  }
  const rec = new Ctor();
  rec.lang = opts.lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) opts.onFinal(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    opts.onInterim(interim);
  };
  rec.onerror = (e) => {
    if (e.error !== "aborted") opts.onError(STT_ERRORS[e.error] ?? `Үн таануу катасы: ${e.error}`);
  };
  rec.onend = opts.onEnd;
  rec.start();
  return { stop: () => rec.stop() };
}

let currentAudio: HTMLAudioElement | null = null;

/** Текстти үн менен окуу: алгач кыргызча MMS-TTS, болбосо браузердин үнү. */
export async function speak(text: string): Promise<"kyrgyz" | "browser" | "none"> {
  stopSpeaking();
  if (!text.trim()) return "none";
  const blob = await fetchKyrgyzSpeech(text);
  if (blob) {
    const url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.onended = () => URL.revokeObjectURL(url);
    await currentAudio.play();
    return "kyrgyz";
  }
  if (!("speechSynthesis" in window)) return "none";
  const voices = await loadVoices();
  // Кыргыз үнү сейрек болот; кийинки жакын варианттар: казак, орус (кириллицаны окуйт).
  const voice =
    voices.find((v) => v.lang.toLowerCase().startsWith("ky")) ??
    voices.find((v) => v.lang.toLowerCase().startsWith("kk")) ??
    voices.find((v) => v.lang.toLowerCase().startsWith("ru"));
  const u = new SpeechSynthesisUtterance(text);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "ky-KG";
  u.rate = 0.95;
  speechSynthesis.speak(u);
  return "browser";
}

export function stopSpeaking() {
  currentAudio?.pause();
  currentAudio = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const v = speechSynthesis.getVoices();
  if (v.length) return Promise.resolve(v);
  return new Promise((res) => {
    const done = () => res(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1200);
  });
}
