// Сүйлөм (utterance) декодери: бир нече жесттен турган үзгүлтүксүз кыймыл → глосстордун ырааттуулугу.
//
// Колдонуучу бир нече жестти катары менен көрсөтүп, ЭКИ КОЛУН ТҮШҮРӨТ — ошондо сүйлөм бүтөт.
// Ичиндеги кыска токтоолор сүйлөмдү бөлбөйт (бир сөз бир нече кыймылдан турушу мүмкүн).
//
// Алгоритм (AI жок, браузерде):
//   1. Кадрлар топтолот; кыймыл энергиясы (MotionMeter) боюнча "чек талапкерлери" — энергиянын
//      жергиликтүү минимумдары (кармоо, токтоо, колдун жоголушу) + башы/аягы.
//   2. Эки талапкердин ортосундагы ар бир бөлүк (250 мс…3 с, ≤ maxSpan талапкер) → белгилер
//      (32 кадрга кайра бөлүнгөн) → классификатор: эң жакын topK глосс жана аралыктар. Бөлүк бир
//      БҮТҮН жест (китепкана үлгүсү) менен салыштырылат — көп кыймылдуу сөздөр бүтүн бойдон калат.
//   2б. Эс алуу (колдор түшүрүлгөн / көрүнбөгөн) кадрлардан гана турган бөлүк — "тыныгуу": наркы
//      дээрлик нөл, жест эмес (сүйлөмдүн ичинде колду кыска убакытка түшүрүү бузбайт).
//   3. Динамикалык программалоо: сүйлөмдү бөлүктөргө бөлүп, Σ(аралык × узактык) + киргизүү айыбы −
//      тил модели (сүйлөмдөр китебинин униграмм/биграмм бонусу) минимум болгон жол. Кыска "таштанды"
//      бөлүктөр (өтүү кыймылы) skipCost менен өткөрүлөт.
//   4. Даяр сүйлөмдөр (phrasebook): ар бир сүйлөмдүн глосс ырааттуулугу ошол эле бөлүктөр боюнча
//      мажбурлап тегиздөө (forced alignment) — эркин декоддон начар эмес болсо, сүйлөм кайтарылат.
//   Бардык эсептөөлөр инкременталдык: чек талапкери тастыкталганда (300 мс кечигүү менен) ага
//   бүткөн бөлүктөр дароо бааланат; колдор түшкөндө акыркы тилке гана калат → жооп < 100 мс.

import type { MocapClip, MocapFrame } from "../lib/types";
import type { SignClassifier } from "./classifier";
import { clipFeatures, clipScale } from "./features";
import { MotionMeter, RestTracker, toClip } from "./segmenter";

export interface UtteranceSegment {
  gloss: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface UtteranceResult {
  /** декоддолгон жесттердин ырааттуулугу */
  gloss: string[];
  /** дал келген даяр сүйлөм (болсо) */
  phrase: { text: string; gloss: string[]; score: number } | null;
  /** 0..1 жалпы ишеним */
  confidence: number;
  segments: UtteranceSegment[];
  /** диагностика: эркин декоддун орточо аралыгы (бир кадрга), чек талапкерлеринин саны, эсептөө убактысы */
  stats?: { score: number; bounds: number; decodeMs: number; evaluated: number; evaluatedAtFinish: number; phraseMs: number };
}

export interface PhraseTemplate {
  text: string;
  gloss: string[];
}

export interface DecoderOptions {
  /** Чек талапкерлеринин эң кичине аралыгы, мс (демейки 200) */
  minGapMs?: number;
  /** Минимумдун "көрүнүктүүлүгү" каралуучу терезе, мс (демейки 350) */
  prominenceMs?: number;
  /** Минимум айланасындагы максимумдун ушул үлүшүнөн төмөн болушу керек (демейки 0.6) */
  prominence?: number;
  /**
   * Ушунча мс бою энергиянын минимуму табылбаса (мис. "мен/мага/анын" сыяктуу кичине кыймылдуу
   * жесттер катары менен), ошол аралыктагы энергиясы эң аз кадр кошумча чек болот. Чек жесттерди
   * мажбурлап бөлбөйт — DP аны колдонбой коюшу мүмкүн. 0 — өчүк. Демейки 600.
   */
  maxGapMs?: number;
  /** Бир жесттин узактыгы, мс (демейки 250…4500 — даяр сүйлөмдөрдүн үлгүлөрү 4–5 с болушу мүмкүн) */
  minSegMs?: number;
  maxSegMs?: number;
  /** Бир бөлүк ушунчадан ашык талапкерди камтыбайт (демейки 12 — көп кыймылдуу узун жесттер бөлүнбөсүн) */
  maxSpan?: number;
  /** Ар бир жест үчүн айып (аралык × сек бирдигинде, демейки 0.2) */
  insertion?: number;
  /** Ошол эле глосс катары менен кайталанса — кошумча айып (бир жест экиге бөлүнбөсүн), демейки 0.15 */
  repeatPenalty?: number;
  /** "Таштанды" бөлүктүн секундасына айып (демейки 1.1) жана эң узун таштанды, мс (демейки 600) */
  skipCost?: number;
  maxSkipMs?: number;
  /** Тил модели: сүйлөмдөр китебиндеги сөз (демейки 0.02) жана жуп (демейки 0.06) үчүн бонус */
  lmUnigram?: number;
  lmBigram?: number;
  /** Даяр сүйлөм эркин декоддон ушунча эседен ашык начар болбосо — сүйлөм тандалат (демейки 1.12) */
  phraseMargin?: number;
  /** Ар бөлүктө сакталуучу талапкерлер (демейки 5) */
  topK?: number;
  /**
   * Бир push() ичинде бааланган бөлүктөрдүн эң көп саны (демейки 1): иш кадрларга бөлүштүрүлөт,
   * интерфейс катып калбайт; калганы finish() ичинде бүтөт. 0 — чексиз (баары дароо).
   */
  evalsPerPush?: number;
  /**
   * Бир push() ичинде кезектеги бөлүктөрдү ушунча мс бою баалай берет (evalsPerPush'тан кийин да).
   * Кадр сейрек келсе (начар камера, 15 fps) иш артта калбайт — колдор түшкөндө декоддоо тез.
   * Интерфейстин бир кадрына таасири ушул чектен ашпайт. 0 — өчүк. Демейки 6.
   */
  pushBudgetMs?: number;
  /**
   * Активдүү сөздүк ушунчадан көп глосс болсо, эки баскычтуу издөө колдонулат (classifier coarse):
   * адегенде орун боюнча эң жакын `coarse` глосс, анан толук DTW. Демейки 150 / 80.
   */
  coarseAbove?: number;
  coarse?: number;
}

const DEF: Required<DecoderOptions> = {
  minGapMs: 200,
  prominenceMs: 350,
  prominence: 0.6,
  maxGapMs: 600,
  minSegMs: 250,
  maxSegMs: 4500,
  maxSpan: 12,
  insertion: 0.2,
  repeatPenalty: 0.15,
  skipCost: 1.1,
  maxSkipMs: 600,
  lmUnigram: 0.02,
  lmBigram: 0.06,
  phraseMargin: 1.12,
  topK: 5,
  evalsPerPush: 1,
  pushBudgetMs: 6,
  coarseAbove: 150,
  coarse: 80,
};

interface SegEval {
  a: number;
  b: number;
  /** узактыгы, сек */
  dur: number;
  /** topK: глосс, аралык */
  top: { gloss: string; dist: number }[];
  /** даяр сүйлөмдөрдүн глосстору үчүн аралыктар (так же болжолдуу — ensureDist) */
  phrase: Map<string, number>;
  /** phrase ичинде так эсептелген глосстор */
  exactPhrase: Set<string>;
  /** бөлүктүн белгилери (кошумча аралыктар үчүн) */
  q: Float32Array;
}

interface State {
  cost: number;
  /** мурунку чек (bounds индекси) */
  prev: number;
  prevGloss: string | null;
  gloss: string | null;
  dist: number;
}

const SKIP = "\u0000skip";
/** Тыныгуу (эс алуу) бөлүгүнүн секундасына наркы — дээрлик нөл */
const REST_COST = 0.02;

export class UtteranceDecoder {
  private o: Required<DecoderOptions>;
  private frames: MocapFrame[] = [];
  private energy: number[] = [];
  /** кадр боюнча: кол эс алуу зонасынан жогорубу */
  private raised: boolean[] = [];
  private meter = new MotionMeter();
  private restTracker = new RestTracker();
  private cache = new Map<number, SegEval>();
  private scale: number | undefined;
  private mirror: boolean | null = null;
  private unigram = new Set<string>();
  private bigram = new Set<string>();
  private phraseGlosses = new Set<string>();
  private evaluated = 0;
  /** ушул индекске чейинки кадрлар чек катары текшерилген */
  private scanned = 1;
  /** тастыкталган чек талапкерлери (кадр индекстери), 0 менен башталат */
  private bounds: number[] = [0];
  /** DP: ар бир чек үчүн глосс → абал */
  private states: Map<string, State>[] = [new Map([[SKIP, { cost: 0, prev: -1, prevGloss: null, gloss: null, dist: 0 }]])];
  /** баалана элек бөлүктөр (чек тартибинде) */
  private queue: { i: number; j: number }[] = [];
  /** ар бир чек үчүн баалана элек бөлүктөрдүн саны */
  private pendingOf: number[] = [0];
  /** DP абалы толук эсептелген акыркы чек */
  private finalized = 0;
  private phrases: PhraseTemplate[] = [];

  constructor(private classifier: SignClassifier, phrases: PhraseTemplate[] = [], opts: DecoderOptions = {}) {
    this.o = { ...DEF, ...opts };
    this.setPhrases(phrases);
  }

  setPhrases(phrases: PhraseTemplate[]): void {
    const known = new Set(this.classifier.allGlosses);
    this.phrases = phrases.filter((p) => p.gloss.length && p.gloss.every((g) => known.has(g)));
    this.unigram.clear(); this.bigram.clear(); this.phraseGlosses.clear();
    for (const p of this.phrases) {
      for (let i = 0; i < p.gloss.length; i++) {
        this.unigram.add(p.gloss[i]);
        this.phraseGlosses.add(p.gloss[i]);
        if (i) this.bigram.add(p.gloss[i - 1] + "\u0001" + p.gloss[i]);
      }
    }
  }

  reset(): void {
    this.frames = [];
    this.energy = [];
    this.raised = [];
    this.meter.reset();
    this.restTracker.reset();
    this.cache.clear();
    this.scale = undefined;
    this.mirror = null;
    this.evaluated = 0;
    this.scanned = 1;
    this.bounds = [0];
    this.states = [new Map([[SKIP, { cost: 0, prev: -1, prevGloss: null, gloss: null, dist: 0 }]])];
    this.queue = [];
    this.pendingOf = [0];
    this.finalized = 0;
  }

  get length(): number {
    return this.frames.length;
  }

  /**
   * Кадр кошот; тастыкталган жаңы чек талапкерлери болсо, аларга бүткөн бөлүктөрдү баалайт.
   * raised — кол эс алуу зонасынан жогорубу (сегментатордон; берилбесе өзү эсептейт).
   */
  push(frame: MocapFrame, raised?: boolean): void {
    this.frames.push(frame);
    const m = this.meter.push(frame);
    this.energy.push(m.energy);
    this.raised.push(raised ?? this.restTracker.push(frame, m.energy, m.scale));
    // Өлчөм бирдигин биринчи ~1 с боюнча бекитебиз (кийинки бөлүктөр бирдей бирдикте болсун)
    if (this.scale === undefined && this.frames.length >= 15) this.scale = clipScale(this.frames) ?? undefined;
    this.confirmBounds(false);
    // кезек топтолсо, бир кадрда эки бөлүк (болбосо бүтүрүүдө чоң жүк калат)
    const per = this.o.evalsPerPush;
    this.work(per > 0 && this.queue.length > 6 ? per + 1 : per, this.o.pushBudgetMs);
  }

  /** Учурдагы эң жакшы жарым-жартылай гипотеза (болжолдуу): DP толук эсептелген чектерге чейин. */
  hypothesis(): string[] {
    return this.backtrack(this.finalized).map((s) => s.gloss);
  }

  /**
   * Кезектеги бөлүктөрдү баалайт (эң көп `max`, 0 — баарын; `budgetMs` > 0 болсо — max'тан кийин да
   * ушул убакыт бүткөнчө) жана толук бааланган чектердин DP'син бүтүрөт.
   */
  private work(max: number, budgetMs = 0): void {
    let n = 0;
    const t0 = budgetMs > 0 ? performance.now() : 0;
    while (this.queue.length && (max <= 0 || n < max || (budgetMs > 0 && performance.now() - t0 < budgetMs))) {
      const { i, j } = this.queue.shift()!;
      this.evalSegment(this.bounds[i], this.bounds[j]);
      this.pendingOf[j]--;
      n++;
    }
    while (this.finalized + 1 < this.bounds.length && this.pendingOf[this.finalized + 1] === 0) {
      this.finalized++;
      this.relax(this.finalized);
    }
  }

  /**
   * Сүйлөмдү бүтүрөт (колдор түштү) жана декоддойт. endT — сегментатордун аныктаган аягы (кадр
   * убактысы): андан кийинки кадрлар (колдор түшүп жаткан) эске алынбайт.
   */
  finish(endT?: number): UtteranceResult {
    const t0 = performance.now();
    const evalBefore = this.evaluated;
    if (endT !== undefined) this.truncate(endT);
    // Акыркы тастыкталган чек аягына жакын болсо (≤ 300 мс) — куйрук колдун түшө башташы гана:
    // аны алып салабыз, ошондо аягына бүткөн бөлүктөр мурун эле бааланган (кечигүү аз).
    const lastB = this.bounds[this.bounds.length - 1];
    if (this.bounds.length > 1 && this.frames.length > 1 && this.frames[this.frames.length - 1].t - this.frames[lastB].t <= 300) this.truncate(this.frames[lastB].t);
    this.confirmBounds(true);
    this.work(0);
    const n = this.frames.length;
    const last = this.bounds.length - 1;
    const path = this.backtrack(last);
    const total = n > 1 ? (this.frames[n - 1].t - this.frames[0].t) / 1000 : 0;
    const segments: UtteranceSegment[] = [];
    let raw = 0;
    for (const s of path) {
      raw += s.dist * s.dur;
      segments.push({ gloss: s.gloss, startMs: this.frames[s.a].t - this.frames[0].t, endMs: this.frames[s.b].t - this.frames[0].t, confidence: s.conf });
    }
    const freeScore = total > 0 ? raw / total : Infinity;
    const tp = performance.now();
    const phrase = this.bestPhrase(last, total);
    let result: UtteranceResult;
    const stats = { score: freeScore, bounds: this.bounds.length, decodeMs: 0, evaluated: this.evaluated, evaluatedAtFinish: this.evaluated - evalBefore, phraseMs: performance.now() - tp };
    const gl = segments.map((s) => s.gloss);
    const asPhrase = phrase && (phrase.score <= freeScore * this.o.phraseMargin || sameSeq(phrase.gloss, gl));
    if (phrase && asPhrase) {
      result = { gloss: phrase.gloss.slice(), phrase: { text: phrase.text, gloss: phrase.gloss.slice(), score: phrase.score }, confidence: phrase.confidence, segments: phrase.segments, stats };
    } else {
      const conf = segments.length ? Math.min(...segments.map((s) => s.confidence)) : 0;
      // эркин декод даяр сүйлөмгө дал келсе — ошону да кайтарабыз
      const exact = this.phrases.find((p) => sameSeq(p.gloss, gl));
      result = { gloss: gl, phrase: exact ? { text: exact.text, gloss: exact.gloss.slice(), score: freeScore } : null, confidence: conf, segments, stats };
    }
    stats.decodeMs = performance.now() - t0;
    return result;
  }

  /** Берилген ырааттуулукту мажбурлап тегиздейт (үйрөнүү: "ушул сүйлөм көрсөтүлдүбү?"). */
  forcedAlign(target: string[]): { score: number; segments: UtteranceSegment[]; confidence: number } | null {
    this.confirmBounds(true);
    this.work(0);
    const n = this.frames.length;
    const total = n > 1 ? (this.frames[n - 1].t - this.frames[0].t) / 1000 : 0;
    // бөлүктөрдө top-K аралыктар гана бар; максаттуу глосстор үчүн ТАК аралык эсептелет (үйрөнүүчүнүн
    // жести 6-орунда болсо да адилет баа алышы керек)
    const maxDist = this.maxDist();
    for (const e of this.cache.values()) {
      const missing = target.filter((g) => !e.top.some((t) => t.gloss === g) && !e.exactPhrase.has(g));
      if (!missing.length) continue;
      for (const [g, d] of this.classifier.distancesFor(e.q, missing, maxDist)) { e.phrase.set(g, d); e.exactPhrase.add(g); }
    }
    return this.alignSeq(target, this.bounds.length - 1, total);
  }

  /** endT кийинки кадрларды (жана аларга таянган чектерди) алып салат */
  private truncate(endT: number): void {
    let n = this.frames.length;
    while (n > 1 && this.frames[n - 1].t > endT) n--;
    if (n === this.frames.length) return;
    this.frames.length = n;
    this.energy.length = n;
    this.raised.length = n;
    while (this.bounds.length > 1 && this.bounds[this.bounds.length - 1] > n - 1) {
      this.bounds.pop();
      this.states.pop();
      this.pendingOf.pop();
    }
    this.queue = this.queue.filter((q) => q.j < this.bounds.length);
    this.finalized = Math.min(this.finalized, this.bounds.length - 1);
    for (const k of [...this.cache.keys()]) if (k % 1_000_000 > n - 1) this.cache.delete(k);
    this.scanned = Math.min(this.scanned, n - 1);
  }

  // ───────────────────────── чек талапкерлери ─────────────────────────

  private frameMs(i: number): number {
    return this.frames[i].t;
  }

  /** Энергиянын жергиликтүү минимумдары; final=true болсо акыркы кадр да чек. */
  private confirmBounds(final: boolean): void {
    const n = this.frames.length;
    if (n < 2) return;
    const o = this.o;
    const tEnd = this.frameMs(n - 1);
    // Кадр i минимум деп тастыкталышы үчүн i + prominenceMs көрүнүп турушу керек
    let i = Math.max(this.scanned, this.bounds[this.bounds.length - 1] + 1);
    while (i < n - 1) {
      const t = this.frameMs(i);
      if (!final && tEnd - t < o.prominenceMs) break;
      const lastT = this.frameMs(this.bounds[this.bounds.length - 1]);
      if (t - lastT >= o.minGapMs && this.isMinimum(i)) {
        this.addBound(i);
      } else if (o.maxGapMs > 0 && t - lastT >= o.maxGapMs) {
        // Узак убакыт чек жок — аралыктагы энергиясы эң аз кадрды кошумча чек кылабыз
        const k = this.quietestFrame(this.bounds[this.bounds.length - 1] + 1, i, lastT + o.minGapMs);
        this.addBound(k);
        i = k;
      }
      i++;
    }
    this.scanned = i;
    if (final) {
      const lastB = this.bounds[this.bounds.length - 1];
      if (lastB !== n - 1) {
        if (this.frameMs(n - 1) - this.frameMs(lastB) < o.minSegMs && this.bounds.length > 1) {
          // аягындагы өтө кыска куйрук: акыркы чекти аягына жылдырабыз
          this.bounds.pop();
          this.states.pop();
          this.pendingOf.pop();
          this.queue = this.queue.filter((q) => q.j < this.bounds.length);
          this.finalized = Math.min(this.finalized, this.bounds.length - 1);
        }
        this.addBound(n - 1);
      }
    }
  }

  /** [from, to] аралыгындагы (убактысы minT'дан кийинки) энергиясы эң аз кадр */
  private quietestFrame(from: number, to: number, minT: number): number {
    let best = to, bestE = Infinity;
    for (let k = from; k <= to; k++) {
      if (this.frameMs(k) < minT) continue;
      if (this.energy[k] < bestE) { bestE = this.energy[k]; best = k; }
    }
    return best;
  }

  private isMinimum(i: number): boolean {
    const e = this.energy, o = this.o;
    const t = this.frameMs(i);
    const f = this.frames[i];
    // эс алуу ↔ жест өтүүсү — ар дайым чек
    if (this.raised[i] !== this.raised[i - 1]) return true;
    if (!f.leftHand && !f.rightHand) {
      // кол жок (жоголду) — чек; бирок катары менен келген "кол жок" кадрлардан биринчиси гана
      const p = this.frames[i - 1];
      return !!(p.leftHand || p.rightHand);
    }
    const G = o.minGapMs / 2, P = o.prominenceMs;
    let maxP = 0;
    for (let j = i - 1; j >= 0 && t - this.frameMs(j) <= P; j--) {
      if (t - this.frameMs(j) <= G && e[j] < e[i]) return false;
      if (e[j] > maxP) maxP = e[j];
    }
    for (let j = i + 1; j < this.frames.length && this.frameMs(j) - t <= P; j++) {
      if (this.frameMs(j) - t <= G && e[j] <= e[i]) return false;
      if (e[j] > maxP) maxP = e[j];
    }
    return e[i] < o.prominence * maxP;
  }

  /** Жаңы чек: ага бүткөн жест бөлүктөрү кезекке коюлат; DP work() ичинде бүтөт */
  private addBound(b: number): void {
    this.bounds.push(b);
    const j = this.bounds.length - 1;
    this.states.push(new Map());
    const o = this.o;
    let pending = 0;
    for (let i = Math.max(0, j - o.maxSpan); i < j; i++) {
      const bi = this.bounds[i];
      const durMs = this.frames[b].t - this.frames[bi].t;
      if (durMs < o.minSegMs || durMs > o.maxSegMs || this.isRest(bi, b)) continue;
      if (this.cache.has(bi * 1_000_000 + b)) continue;
      this.queue.push({ i, j });
      pending++;
    }
    this.pendingOf.push(pending);
  }

  // ───────────────────────── бөлүктөрдү баалоо ─────────────────────────

  private evalSegment(a: number, b: number): SegEval | null {
    const key = a * 1_000_000 + b;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const frames = this.frames.slice(a, b + 1);
    const dur = (this.frames[b].t - this.frames[a].t) / 1000;
    const clip = toClip(frames);
    if (!frames.some((f) => f.leftHand || f.rightHand)) return null;
    const maxDist = this.maxDist();
    const coarse = this.classifier.vocabulary.length > this.o.coarseAbove ? this.o.coarse : 0;
    let q: Float32Array | null = null;
    let r: ReturnType<SignClassifier["rankSequence"]> = null;
    if (this.mirror === null) {
      // Сүйлөмдүн багыты (сол/оң колдуу) биринчи бөлүктө чечилет; белгисиз болсо — экөө тең салыштырылат
      const side = this.classifier.detectSide(toClip(this.frames));
      if (side !== null) this.mirror = side;
      else {
        const q0 = clipFeatures(clip, { mirror: false, scale: this.scale, smooth: 0 });
        const q1 = clipFeatures(clip, { mirror: true, scale: this.scale, smooth: 0 });
        const r0 = q0 ? this.classifier.rankSequence(q0, { mirrored: false, maxDist, topK: this.o.topK, coarse }) : null;
        const r1 = q1 ? this.classifier.rankSequence(q1, { mirrored: true, maxDist, topK: this.o.topK, coarse }) : null;
        const useMirror = !!r1 && (!r0 || r1.ranked[0].dist < r0.ranked[0].dist * 0.97);
        this.mirror = useMirror;
        q = useMirror ? q1 : q0;
        r = useMirror ? r1 : r0;
      }
    }
    if (!q) q = clipFeatures(clip, { mirror: this.mirror, scale: this.scale, smooth: 0 });
    if (!q) return null;
    this.evaluated++;
    if (!r) r = this.classifier.rankSequence(q, { mirrored: this.mirror, maxDist, topK: this.o.topK, coarse });
    const top = r ? r.ranked.slice(0, this.o.topK).map((c) => ({ gloss: c.gloss, dist: c.dist })) : [];
    // даяр сүйлөмдөрдүн глосстору: так эсептелгендери дароо, калганы керек болгондо (ensureDist)
    const phrase = new Map<string, number>();
    const exactPhrase = new Set<string>();
    if (r) for (const c of r.ranked) if (c.exact && this.phraseGlosses.has(c.gloss)) { phrase.set(c.gloss, c.dist); exactPhrase.add(c.gloss); }
    const ev: SegEval = { a, b, dur, top, phrase, exactPhrase, q };
    this.cache.set(key, ev);
    return ev;
  }

  /**
   * Бөлүктүн top-K ичинде жок глосс үчүн аралык: так DTW эмес, K-чы аралык × 1.25 (болжол). Чыныгы
   * аралык ≥ K-чы; мажбурлап тегиздөөдө мындай сүйлөмдөр баары бир жеңбейт — DTW'сыз тез.
   */
  private ensureDist(e: SegEval, glosses: string[]): void {
    const kth = e.top.length ? e.top[e.top.length - 1].dist : this.maxDist();
    for (const g of glosses) if (!e.phrase.has(g) && !e.top.some((t) => t.gloss === g)) e.phrase.set(g, Number.isFinite(kth) ? 1.25 * kth : this.maxDist());
  }

  /** Аралыктын чеги: четке кагуу чегинен (rejectRatio × адаттагы) бир аз алыс — андан ары так эсептөө пайдасыз */
  private maxDist(): number {
    const rej = this.classifier.rejection;
    return 2 * rej.ratio * this.classifier.typicalDistance;
  }

  private distOf(e: SegEval, g: string): number {
    const t = e.top.find((x) => x.gloss === g);
    return t ? t.dist : e.phrase.get(g) ?? Infinity;
  }

  /** j-чекке бүткөн бардык бөлүктөр боюнча DP абалдарын жаңыртат. */
  private relax(j: number): void {
    const o = this.o;
    const out = this.states[j];
    const bj = this.bounds[j];
    for (let i = Math.max(0, j - o.maxSpan); i < j; i++) {
      const bi = this.bounds[i];
      const durMs = this.frames[bj].t - this.frames[bi].t;
      const prevStates = this.states[i];
      if (!prevStates.size) continue;
      if (durMs > o.maxSegMs && !this.isRest(bi, bj)) continue;
      const dur = durMs / 1000;
      // Абалдын ачкычы = акыркы ЖЕСТтин глоссу (SKIP — али жок); таштанды/тыныгуу бөлүк ачкычты сактайт.
      const rest = this.isRest(bi, bj);
      if (rest) {
        for (const [pg, ps] of prevStates) {
          const cost = ps.cost + REST_COST * dur;
          const ex = out.get(pg);
          if (!ex || cost < ex.cost) out.set(pg, { cost, prev: i, prevGloss: pg, gloss: null, dist: 0 });
        }
        continue;
      }
      if (durMs <= o.maxSkipMs) {
        for (const [pg, ps] of prevStates) {
          const cost = ps.cost + o.skipCost * dur;
          const ex = out.get(pg);
          if (!ex || cost < ex.cost) out.set(pg, { cost, prev: i, prevGloss: pg, gloss: null, dist: 0 });
        }
      }
      if (durMs < o.minSegMs) continue;
      const ev = this.evalSegment(bi, bj);
      if (!ev) continue;
      for (const c of ev.top) {
        if (!Number.isFinite(c.dist)) continue;
        for (const [pg, ps] of prevStates) {
          let cost = ps.cost + c.dist * dur + o.insertion;
          if (this.unigram.has(c.gloss)) cost -= o.lmUnigram;
          if (pg !== SKIP && this.bigram.has(pg + "\u0001" + c.gloss)) cost -= o.lmBigram;
          if (pg === c.gloss) cost += o.repeatPenalty;
          const ex = out.get(c.gloss);
          if (!ex || cost < ex.cost) out.set(c.gloss, { cost, prev: i, prevGloss: pg, gloss: c.gloss, dist: c.dist });
        }
      }
    }
  }

  /** (a, b] кадрлардын баары эс алууда (кол түшүрүлгөн же көрүнбөйт) */
  private isRest(a: number, b: number): boolean {
    for (let i = a + 1; i <= b; i++) if (this.raised[i]) return false;
    return true;
  }

  private backtrack(j: number): { gloss: string; a: number; b: number; dur: number; dist: number; conf: number }[] {
    const out: { gloss: string; a: number; b: number; dur: number; dist: number; conf: number }[] = [];
    if (j <= 0) return out;
    let best: State | null = null;
    for (const s of this.states[j].values()) if (!best || s.cost < best.cost) best = s;
    let cur = best, k = j;
    while (cur && k > 0) {
      const i = cur.prev;
      if (cur.gloss) {
        const ev = this.evalSegment(this.bounds[i], this.bounds[k])!;
        out.push({ gloss: cur.gloss, a: this.bounds[i], b: this.bounds[k], dur: ev.dur, dist: cur.dist, conf: this.segConfidence(ev, cur.gloss) });
      }
      cur = i >= 0 ? this.states[i].get(cur.prevGloss ?? SKIP) ?? null : null;
      k = i;
    }
    return out.reverse();
  }

  /** Бөлүктүн ишеними: четке кагуу (аралык / адаттагы) × топ-K ичиндеги softmax */
  private segConfidence(ev: SegEval, gloss: string): number {
    const d = this.distOf(ev, gloss);
    if (!Number.isFinite(d)) return 0;
    const rej = this.classifier.rejection;
    const typical = this.classifier.typicalFor(gloss) || 0.35;
    const ratio = d / typical;
    const accept = 1 / (1 + Math.exp((ratio - rej.ratio) * rej.sharpness));
    let Z = 0;
    for (const c of ev.top) if (Number.isFinite(c.dist)) Z += Math.exp(-(c.dist - d) / rej.temperature);
    if (!ev.top.some((c) => c.gloss === gloss)) Z += 1;
    const p = Z > 0 ? 1 / Z : 0;
    return Math.round(accept * p * 1000) / 1000;
  }

  // ───────────────────────── даяр сүйлөмдөр ─────────────────────────

  private alignSeq(seq: string[], last: number, total: number): { score: number; segments: UtteranceSegment[]; confidence: number } | null {
    const m = seq.length;
    const B = this.bounds.length;
    if (!m || last < 1) return null;
    // F[k][j] — биринчи k глосс j-чекке чейин; таштанды бөлүктөр уруксат (чектин ортосунда)
    const F: Float64Array[] = Array.from({ length: m + 1 }, () => new Float64Array(B).fill(Infinity));
    const back: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(B).fill(-1));
    const skipTo = (from: number, j: number): number => {
      // from чекинен j чекине чейин таштанды (кыска) же тыныгуу (эс алуу, каалаган узундук) менен өтүү наркы
      const ms = this.frames[this.bounds[j]].t - this.frames[this.bounds[from]].t;
      if (this.isRest(this.bounds[from], this.bounds[j])) return (REST_COST * ms) / 1000;
      return ms <= this.o.maxSkipMs ? (this.o.skipCost * ms) / 1000 : Infinity;
    };
    F[0][0] = 0;
    for (let j = 1; j < B; j++) {
      // таштанды өтүүлөр (k = 0 жана k = m үчүн башталышта/аягында; ортосунда да)
      for (let k = 0; k <= m; k++) {
        for (let i = Math.max(0, j - this.o.maxSpan); i < j; i++) {
          if (!Number.isFinite(F[k][i])) continue;
          const c = F[k][i] + skipTo(i, j);
          if (c < F[k][j]) { F[k][j] = c; back[k][j] = i; }
        }
      }
      for (let k = 1; k <= m; k++) {
        for (let i = Math.max(0, j - this.o.maxSpan); i < j; i++) {
          if (!Number.isFinite(F[k - 1][i])) continue;
          const durMs = this.frames[this.bounds[j]].t - this.frames[this.bounds[i]].t;
          if (durMs < this.o.minSegMs || durMs > this.o.maxSegMs) continue;
          const ev = this.evalSegment(this.bounds[i], this.bounds[j]);
          if (!ev) continue;
          this.ensureDist(ev, [seq[k - 1]]);
          const d = this.distOf(ev, seq[k - 1]);
          if (!Number.isFinite(d)) continue;
          const c = F[k - 1][i] + (d * durMs) / 1000;
          if (c < F[k][j]) { F[k][j] = c; back[k][j] = -2 - i; }
        }
      }
    }
    if (!Number.isFinite(F[m][last])) return null;
    const segments: UtteranceSegment[] = [];
    let k = m, j = last;
    while (j > 0) {
      const bk = back[k][j];
      if (bk === -1) return null;
      if (bk >= 0) { j = bk; continue; }
      const i = -2 - bk;
      const ev = this.evalSegment(this.bounds[i], this.bounds[j])!;
      segments.push({ gloss: seq[k - 1], startMs: this.frames[ev.a].t - this.frames[0].t, endMs: this.frames[ev.b].t - this.frames[0].t, confidence: this.segConfidence(ev, seq[k - 1]) });
      k--; j = i;
    }
    if (k !== 0) return null;
    segments.reverse();
    const confidence = Math.min(...segments.map((s) => s.confidence));
    return { score: total > 0 ? F[m][last] / total : Infinity, segments, confidence };
  }

  private bestPhrase(last: number, total: number): { text: string; gloss: string[]; score: number; segments: UtteranceSegment[]; confidence: number } | null {
    let best: { text: string; gloss: string[]; score: number; segments: UtteranceSegment[]; confidence: number } | null = null;
    // Талапкер сүйлөмдөр: ар бир глоссу кайсы бир бөлүктүн top-K ичинде болгондору гана
    // (башкалары үчүн мажбурлап тегиздөө эч качан эркин декоддон жакшы болбойт)
    const seen = new Set<string>();
    for (const e of this.cache.values()) for (const t of e.top) seen.add(t.gloss);
    for (const p of this.phrases) {
      if (!p.gloss.every((g) => seen.has(g))) continue;
      const r = this.alignSeq(p.gloss, last, total);
      if (!r) continue;
      // узунураак сүйлөм артыкчылыктуу эмес: орточо аралык салыштырылат, бирок ар бир жест кабыл алынышы керек
      if (r.confidence < 0.15) continue;
      if (!best || r.score < best.score) best = { text: p.text, gloss: p.gloss, ...r };
    }
    return best;
  }
}

function sameSeq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

/** Даяр клипти (сүйлөмдү) декоддойт — синхрондуу. */
export function decodeUtterance(classifier: SignClassifier, clip: MocapClip, phrases: PhraseTemplate[] = [], opts?: DecoderOptions): UtteranceResult {
  const d = new UtteranceDecoder(classifier, phrases, opts);
  for (const f of clip.frames) d.push(f);
  return d.finish();
}
