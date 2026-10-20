// Бүт тиркеме үчүн бир таануу модели (жест → глосс). AI колдонулбайт: DTW k-NN, браузерде.
// Модуль деңгээлиндеги жалгыз нуска (singleton):
//   • китепкананын алдын ала эсептелген үлгүлөрү (templates.bin) бир жолу жүктөлөт;
//   • колдонуучунун Студиядагы жаздыруулары (entry.samples) + ЖЕКЕ үлгүлөр (personal samples — таануу
//     үчүн гана, аватардын клибине тийбейт) кошулат жана өзгөргөндө кайра окутулат;
//   • активдүү сөздүк: "conversation" (демейки, ~280 күнүмдүк глосс, src/data/conversationVocab.ts)
//     же "all" (китепкананын баары, ~1280) — setVocabularyMode();
//   • даяр сүйлөмдөр (/api/phrases) декодердин тез жолу жана тил модели үчүн жүктөлөт.
//
// ───────────── Түз эфирде бир жестти / сүйлөмдү жаздыруу: useSignCapture ─────────────
//
//   const cap = useSignCapture({
//     active: cameraOn,                 // камера күйүкпү
//     mode: "utterance",                // "utterance" (демейки): кол көтөрүлгөндөн ЭКИ кол түшкөнгө чейин —
//                                       //   бир нече жест, аягында декодер → onUtterance(clip, result)
//                                       // "sign": ар бир жест өзүнчө (кыймыл токтогондо) → onSegment(clip, r)
//     onUtterance: (clip, result) => …, // result: UtteranceResult | null (классификатор жүктөлө элек болсо)
//     onSegment: (clip, r) => …,        // "sign" режими: r: Recognition | null
//     onHypothesis: (gloss) => …,       // сүйлөм жүрүп жатканда жарым-жартылай гипотеза
//     onProvisional: (r) => …,          // "sign" режими: жест жүрүп жатканда болжолдуу жооп
//   });
//   <CameraView {...cap.cameraProps} accent="…">…</CameraView>
//   cap.signing — азыр жест/сүйлөм жүрүп жатабы; cap.hypothesis — учурдагы гипотеза (глосстор);
//   cap.provisional — болжолдуу жооп; cap.reset() — буферди тазалоо; cap.classifier / cap.loading.
//
// Жаздырылган клипти текшерүү (үйрөнүү барагы): checkSign(classifier, clip, "САЛАМ"),
// checkSequence(classifier, clip, ["САЛАМ", "СИЗ"]); жеке үлгү сактоо: savePersonalSample(gloss, clip).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createStore, del, get, keys, set, clear as clearStore, entries as storeEntries } from "idb-keyval";
import { CONVERSATION_VOCAB } from "../data/conversationVocab";
import { loadTemplateBank } from "../data/library";
import { listSigns, normalizeGloss, onDictionaryChange } from "../data/store";
import { SignClassifier } from "../vision/classifier";
import { UtteranceDecoder, decodeUtterance as decodeWith, type PhraseTemplate, type UtteranceResult } from "../vision/decoder";
import { LiveRecognizer, type LiveEvents } from "../vision/live";
import type { TrackResult } from "../vision/tracker";
import { fetchPhrases } from "./room";
import type { MocapClip, Recognition, SignEntry } from "./types";

export type { UtteranceResult } from "../vision/decoder";

export type VocabularyMode = "conversation" | "all";
export type Handedness = "auto" | "right" | "left";

export interface RecognizerState {
  /** null — азырынча даяр эмес */
  classifier: SignClassifier | null;
  loading: boolean;
  /** Тааный турган (активдүү) глосстордун саны */
  vocabulary: number;
  vocabularyMode: VocabularyMode;
  handedness: Handedness;
  /** Даяр сүйлөмдөр (декодер үчүн); жүктөлө элек болсо бош */
  phrases: PhraseTemplate[];
}

const VOCAB_KEY = "speak:recVocab";
const HAND_KEY = "speak:recHandedness";

function readSetting<T extends string>(key: string, allowed: readonly T[], def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : def;
  } catch {
    return def;
  }
}

let state: RecognizerState = {
  classifier: null,
  loading: true,
  vocabulary: 0,
  vocabularyMode: readSetting(VOCAB_KEY, ["conversation", "all"] as const, "conversation"),
  handedness: readSetting(HAND_KEY, ["auto", "right", "left"] as const, "auto"),
  phrases: [],
};
const subs = new Set<(s: RecognizerState) => void>();
let started = false;

function publish(next: Partial<RecognizerState>) {
  state = { ...state, ...next };
  subs.forEach((f) => f(state));
}

function applyVocabulary(c: SignClassifier) {
  c.setVocabulary(state.vocabularyMode === "conversation" ? CONVERSATION_VOCAB : null);
}

// ───────────────────────── жеке үлгүлөр (IndexedDB) ─────────────────────────

const personalDb = createStore("speak-jest", "personal");
/** Бир глосско сакталуучу жеке үлгүлөрдүн эң көп саны (эң эскиси өчүрүлөт) */
const MAX_PERSONAL = 12;
const personalListeners = new Set<() => void>();

async function readPersonal(gloss: string): Promise<MocapClip[]> {
  return (await get<MocapClip[]>(normalizeGloss(gloss), personalDb)) ?? [];
}

/** Бардык жеке үлгүлөр SignEntry түрүндө (окутуу үчүн) */
async function personalEntries(): Promise<SignEntry[]> {
  const all = (await storeEntries<string, MocapClip[]>(personalDb)) ?? [];
  return all
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([gloss, samples]) => ({ gloss, aliases: [], clip: null, samples, source: "recorded" as const, createdAt: 0 }));
}

/**
 * Колдонуучунун өз аткарган мисалын сактайт (IndexedDB, таануу үчүн ГАНА — аватардын клибин
 * алмаштырбайт). Таануу модели кайра окутулат. Кайтарат: бул глосстун жеке үлгүлөрүнүн саны.
 */
export async function savePersonalSample(gloss: string, clip: MocapClip): Promise<number> {
  const key = normalizeGloss(gloss);
  const list = await readPersonal(key);
  list.push({ kind: "mocap", fps: clip.fps, frames: clip.frames });
  while (list.length > MAX_PERSONAL) list.shift();
  await set(key, list, personalDb);
  personalListeners.forEach((l) => l());
  return list.length;
}

export async function personalSampleCount(gloss: string): Promise<number> {
  return (await readPersonal(gloss)).length;
}

/** Жеке үлгүлөрдү өчүрөт (глосс берилбесе — баарын). */
export async function clearPersonalSamples(gloss?: string): Promise<void> {
  if (gloss) await del(normalizeGloss(gloss), personalDb);
  else await clearStore(personalDb);
  personalListeners.forEach((l) => l());
}

/** Жеке үлгүсү бар глосстор */
export async function personalGlosses(): Promise<string[]> {
  return ((await keys<string>(personalDb)) ?? []).map(String);
}

/** Жеке үлгүлөр өзгөргөндө чакырылат */
export function onPersonalChange(fn: () => void): () => void {
  personalListeners.add(fn);
  return () => personalListeners.delete(fn);
}

// ───────────────────────── ишке киргизүү ─────────────────────────

function start() {
  if (started) return;
  started = true;
  void (async () => {
    const c = new SignClassifier({ handedness: state.handedness });
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
      const [signs, personal] = await Promise.all([listSigns(), personalEntries().catch(() => [] as SignEntry[])]);
      if (my !== seq) return;
      c.train([...signs.filter((s) => s.source !== "library"), ...personal]);
      applyVocabulary(c);
      publish({ classifier: c, loading: false, vocabulary: c.vocabulary.length });
    };
    onDictionaryChange(() => void train());
    onPersonalChange(() => void train());
    await train();
  })().catch((e) => {
    console.warn("[recognizer] даярдалган жок:", e);
    publish({ classifier: null, loading: false, vocabulary: 0 });
  });
  // даяр сүйлөмдөр — декодердин тез жолу (жок болсо да иштейт)
  fetchPhrases()
    .then((items) => publish({ phrases: items.map((p) => ({ text: p.text, gloss: p.gloss })) }))
    .catch(() => {});
}

/** Жалгыз таануу моделин алдын ала даярдоо (мис. бөлмөгө киргенде). */
export function warmUpRecognizer(): void {
  start();
}

/** Активдүү сөздүк: "conversation" (күнүмдүк ~280 глосс + жеке үлгүлөр) же "all" (китепкананын баары). */
export function setVocabularyMode(mode: VocabularyMode): void {
  try { localStorage.setItem(VOCAB_KEY, mode); } catch { /* жеке режим */ }
  publish({ vocabularyMode: mode });
  const c = state.classifier;
  if (c) {
    applyVocabulary(c);
    publish({ vocabulary: c.vocabulary.length });
  }
}

/** Колдун багыты: "auto" — сегмент боюнча аныкталат; "left" — сол колдуу (кадрлар күзгүлөнөт). */
export function setHandedness(h: Handedness): void {
  try { localStorage.setItem(HAND_KEY, h); } catch { /* жеке режим */ }
  publish({ handedness: h });
  state.classifier?.configure({ handedness: h });
}

/** Жүктөлгөн даяр сүйлөмдөр (декодер үчүн) */
export function getPhrases(): PhraseTemplate[] {
  return state.phrases;
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

// ───────────────────────── текшерүү (үйрөнүү барагы) ─────────────────────────

export interface SignCheck {
  /** аткарылган жест максаттуу жест катары кабыл алынды */
  ok: boolean;
  /** 0..1 — максатка окшоштук (прогресс тилкеси үчүн) */
  score: number;
  /** максаттын талапкерлердин ичиндеги орду (1 = эң жакшы), табылбаса Infinity */
  rank: number;
  /** таануучу эмне деп ойлойт */
  best: Recognition | null;
}

/** Аралык / адаттагы аралык катышынан 0..1 упай: 0.5 → 1.0, 1.0 → 0.75, 2.0 → 0.25, ≥ 2.5 → 0 */
function ratioScore(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.round(Math.max(0, Math.min(1, 1.25 - 0.5 * ratio)) * 1000) / 1000;
}

/** `clip` — `target` жестиби? Максат активдүү сөздүккө кошулуп салыштырылат. */
export function checkSign(classifier: SignClassifier, clip: MocapClip, target: string): SignCheck {
  const t = normalizeGloss(target);
  const d = classifier.classifyDetailed(clip, { include: [t] });
  if (!d) return { ok: false, score: 0, rank: Infinity, best: null };
  const best: Recognition = {
    gloss: d.ranked[0].gloss,
    confidence: d.ranked[0].confidence,
    alternatives: d.ranked.slice(1, 5).map((c) => ({ gloss: c.gloss, confidence: c.confidence })),
  };
  const idx = d.ranked.findIndex((c) => c.gloss === t);
  if (idx < 0) return { ok: false, score: 0, rank: Infinity, best };
  const typical = classifier.typicalFor(t) || 0.35;
  const score = ratioScore(d.ranked[idx].dist / typical);
  const rank = idx + 1;
  return { ok: rank <= 2 && score >= 0.5, score, rank, best };
}

/**
 * `clip` — `target` жесттеринин ырааттуулугубу? Сүйлөм максаттуу ырааттуулук боюнча мажбурлап
 * тегизделет; matched[i] — i-жест кабыл алындыбы. rank: 1 — эркин декод дал келди, 2 — тегиздөө
 * эркин декоддон анча начар эмес, болбосо Infinity.
 */
export function checkSequence(classifier: SignClassifier, clip: MocapClip, target: string[]): SignCheck & { matched: boolean[] } {
  const seq = target.map(normalizeGloss);
  const dec = new UtteranceDecoder(classifier, state.phrases);
  for (const f of clip.frames) dec.push(f);
  const free = dec.finish();
  const aligned = dec.forcedAlign(seq);
  const best: Recognition | null = free.gloss.length ? { gloss: free.gloss.join(" "), confidence: free.confidence, alternatives: [] } : null;
  if (!aligned) return { ok: false, score: 0, rank: Infinity, best, matched: seq.map(() => false) };
  const matched = aligned.segments.map((s) => s.confidence >= 0.35);
  // ар бир жесттин упайы = бөлүктүн ишеними (четке кагуу × талапкерлердин ичиндеги үлүшү)
  const perSign = aligned.segments.map((s) => Math.max(0, Math.min(1, s.confidence)));
  const score = perSign.length ? Math.round((perSign.reduce((a, b) => a + b, 0) / perSign.length) * 1000) / 1000 : 0;
  const exact = free.gloss.length === seq.length && free.gloss.every((g, i) => g === seq[i]);
  const freeScore = free.stats?.score ?? Infinity;
  const rank = exact ? 1 : aligned.score <= freeScore * 1.25 ? 2 : Infinity;
  const ok = matched.every(Boolean) && rank <= 2;
  return { ok, score, rank, best, matched };
}

/** Сүйлөмдү (бир нече жест, аягында колдор түшөт) глосстордун ырааттуулугуна декоддойт — синхрондуу. */
export function decodeUtterance(classifier: SignClassifier, clip: MocapClip): UtteranceResult {
  return decodeWith(classifier, clip, state.phrases);
}

// ───────────────────────── useSignCapture ─────────────────────────

export interface SignCaptureOptions {
  active: boolean;
  /** "utterance" (демейки) же "sign" — караңыз: файлдын башындагы түшүндүрмө */
  mode?: "utterance" | "sign";
  onUtterance?: (clip: MocapClip, result: UtteranceResult | null) => void;
  onSegment?: (clip: MocapClip, r: Recognition | null) => void;
  onHypothesis?: (gloss: string[]) => void;
  onProvisional?: (r: Recognition | null) => void;
}

export interface SignCapture {
  /** <CameraView {...cameraProps}> */
  cameraProps: { active: boolean; onFrame: (res: TrackResult) => void };
  /** азыр жест/сүйлөм жүрүп жатабы */
  signing: boolean;
  /** "utterance": учурдагы жарым-жартылай гипотеза */
  hypothesis: string[];
  /** "sign": жест жүрүп жатканда болжолдуу жооп */
  provisional: Recognition | null;
  reset: () => void;
  /** учурдагы сегментти мажбурлап бүтүрүү */
  flush: () => void;
  classifier: SignClassifier | null;
  loading: boolean;
}

export function useSignCapture(opts: SignCaptureOptions): SignCapture {
  const rec = useRecognizer();
  const [signing, setSigning] = useState(false);
  const [hypothesis, setHypothesis] = useState<string[]>([]);
  const [provisional, setProvisional] = useState<Recognition | null>(null);
  const cb = useRef(opts);
  cb.current = opts;
  const mode = opts.mode ?? "utterance";
  const live = useMemo(() => {
    const events: LiveEvents = {
      onSigning: (a) => setSigning(a),
      onHypothesis: (g) => { setHypothesis(g); cb.current.onHypothesis?.(g); },
      onProvisional: (r) => { setProvisional(r); cb.current.onProvisional?.(r); },
      onUtterance: (clip, result) => cb.current.onUtterance?.(clip, result),
      onSegment: (clip, r) => cb.current.onSegment?.(clip, r),
    };
    return new LiveRecognizer(null, events, { mode });
  }, [mode]);
  live.classifier = rec.classifier;
  useEffect(() => { live.setPhrases(rec.phrases); }, [live, rec.phrases]);
  useEffect(() => {
    if (!opts.active) {
      live.flush();
      live.reset();
      setSigning(false);
      setHypothesis([]);
      setProvisional(null);
    }
  }, [opts.active, live]);
  const onFrame = useCallback((res: TrackResult) => {
    const pose = res.image.pose;
    live.push(res.frame, pose ? { vis: pose.map((p) => p.v ?? 1) } : undefined);
  }, [live]);
  const reset = useCallback(() => { live.reset(); setSigning(false); setHypothesis([]); setProvisional(null); }, [live]);
  const flush = useCallback(() => { live.flush(); }, [live]);
  return { cameraProps: { active: opts.active, onFrame }, signing, hypothesis, provisional, reset, flush, classifier: rec.classifier, loading: rec.loading };
}
