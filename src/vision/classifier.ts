// DTW + k-NN жест классификатору.
//
// • Ар бир үлгү (sample) → N×D белги матрицасы (features.ts).
// • Аралык: Sakoe-Chiba тилкеси менен DTW, кадрлар ортосунда Евклид аралыгы, N'ге бөлүнгөн.
// • Ылдамдык үчүн: LB_Keogh төмөнкү чеги менен алдын ала кесүү + DTW'ны эрте токтотуу.
// • Класстын аралыгы = анын эң жакын k үлгүсүнүн орточосу.
// • Ишеним: класстардын аралыктары боюнча softmax (температура окутуудан калибрленет),
//   андан кийин "белгисиз жест" четке кагуу: эң жакын аралык класстын адаттагы ички
//   аралыгынан бир нече эсе чоң болсо, ишеним төмөндөйт.
// • Үлгүлөр эки булактан: колдонуучунун жаздыруулары (train(entries) → entry.samples) жана
//   китепкананын алдын ала эсептелген банкы (addTemplates(bank) — public/signs/rsl/templates.bin,
//   ушул эле features.ts менен офлайн эсептелген). Экөө бир класс мейкиндигинде бириктирилет.

import type { MocapClip, MocapFrame, Recognition, SignEntry, Vec3 } from "../lib/types";
import { FEATURE_CONFIG, FEATURE_DIM, FEATURE_VERSION, FEATURE_WEIGHTS, HAND_DIM, RESAMPLE_N, clipFeatures } from "./features";

/** Таануунун толук натыйжасы: бардык активдүү класстар аралыгы боюнча иреттелген */
export interface DetailedRecognition {
  ranked: { gloss: string; dist: number; confidence: number; exact: boolean }[];
  /** Эң жакын класстын адаттагы ички аралыгына карата катышы (четке кагуу үчүн) */
  ratio: number;
  mirrored: boolean;
}

export interface ClassifyOptions {
  /** Активдүү сөздүктөн тышкары да эсептелүүчү глосстор (мис. үйрөнүлүп жаткан жест) */
  include?: Iterable<string>;
  /** Күзгүлөөнү мажбурлоо (handedness опциясын четке кагат) */
  mirror?: boolean;
  /**
   * Аралыктын чеги: ушундан алыс үлгүлөр так эсептелбейт (DTW эрте токтойт) — начар дал келген
   * сегменттерде (сүйлөм декодери) эсептөө бир нече эсе тездейт. Демейки чексиз.
   */
  maxDist?: number;
  /** Эң жакшы K класс гана так керек болсо (сүйлөм декодери): K-чы аралык да кесүү чеги болот */
  topK?: number;
  /**
   * Эки баскычтуу издөө: адегенде орун белгилери (билек/чыканак/бар-жок, 14 өлчөм) боюнча арзан DTW
   * бардык үлгүлөргө, анан эң жакын `coarse` үлгүгө гана толук DTW. Чоң сөздүктө (1280 глосс) ~5 эсе
   * тез; жакындашуу (кол формасы биринчи баскычта эске алынбайт). 0 — өчүк (демейки).
   */
  coarse?: number;
}

// Колдун формасы (60 өлчөм) кол көрүнбөсө нөл. Эки ырааттуулукта тең нөл болгон блоктор
// аралыкка эч нерсе кошпойт — DTW/LB аларды өткөрүп жиберет (жыйынтык так ошол эле).
const SHAPE_OFF = [1, HAND_DIM + 1] as const;
const SHAPE_LEN = HAND_DIM - 7;
/** Ар дайым эсептелүүчү өлчөмдөр: presence + билек/чыканак ордулары (эки кол) */
const DENSE_DIMS: Int32Array = (() => {
  const out: number[] = [];
  for (let d = 0; d < FEATURE_DIM; d++) {
    const inShape = SHAPE_OFF.some((o) => d >= o && d < o + SHAPE_LEN);
    if (!inShape) out.push(d);
  }
  return Int32Array.from(out);
})();

/** Ар бир кадр үчүн: бит0 — сол колдун формасы нөл, бит1 — оң колдуку. */
function zeroMask(seq: Float32Array, n: number, D: number): Uint8Array {
  const z = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let h = 0; h < 2; h++) {
      const o = i * D + SHAPE_OFF[h];
      let zero = true;
      for (let d = 0; d < SHAPE_LEN; d++) if (seq[o + d] !== 0) { zero = false; break; }
      if (zero) m |= 1 << h;
    }
    z[i] = m;
  }
  return z;
}

export interface ClassifierOptions {
  /** Sakoe-Chiba тилкесинин жарым туурасы, N'дин үлүшү (демейки 0.2) */
  band?: number;
  /** k-NN: класстын аралыгы эң жакын k үлгүнүн орточосу (демейки 2) */
  k?: number;
  /** softmax температурасы = tempScale × адаттагы ички аралык (демейки 0.25) */
  tempScale?: number;
  /**
   * Четке кагуу: аралык / адаттагы ички аралык ушул чектен ашса, ишеним < 0.5 (демейки 3.0).
   * Түз эфирдеги трекер (pose lite, жылмаланбаган) китепкананын үлгүлөрүнөн ~2.2–2.9 эсе алыс
   * (ошол эле адам, ошол эле видео — vision-replay.html менен өлчөнгөн); 2.0 баарын четке кагат.
   */
  rejectRatio?: number;
  /** Четке кагуунун "катуулугу" (демейки 4) */
  rejectSharpness?: number;
  /** Сол колдуу колдонуучу: таанууда кадрлар күзгүдөй чагылдырылат (handedness: "left" менен бирдей) */
  leftHanded?: boolean;
  /**
   * Колдун багыты: "right" — үлгүлөрдөй (оң кол негизги); "left" — кадрлар күзгүлөнөт;
   * "auto" (демейки) — сегментте сол кол негизги болсо, күзгүлөнөт.
   */
  handedness?: "auto" | "right" | "left";
  /** Колдонуучунун өз үлгүлөрүнүн аралыгына көбөйтүүчү (< 1 — жеке үлгүлөр артыкчылыктуу, демейки 1) */
  userBias?: number;
  /** Таанууда кадрларды себептүү (causal) EMA менен жылмалоо, 0 — өчүк (демейки 0) */
  smooth?: number;
  /** Окутууда ар бир үлгүнүн күзгү көчүрмөсүн да кошуу (сол/оң колдуу аралаш колдонуучулар үчүн) */
  mirrorAugment?: boolean;
  /** Эң кыска сегмент, мс (демейки 150) */
  minDurationMs?: number;
  /** Эң аз кадр саны (демейки 4) */
  minFrames?: number;
  /** softmax'та эске алынбай турган аралык: globalBest + softmaxMargin × температура (демейки 4) */
  softmaxMargin?: number;
}

/** Алдын ала эсептелген үлгүлөр банкы (китепкана). data: count × n × dims, катар боюнча. */
export interface TemplateBank {
  n: number;
  dims: number;
  /** класстардын (глосстордун) тизмеси */
  glosses: string[];
  /** ар бир катардын класс индекси (glosses ичинде) */
  rows: ArrayLike<number>;
  data: Float32Array;
  /** диагностика үчүн клиптин id'си */
  ids?: string[];
  /** Офлайн калибровка: банктын класстары үчүн адаттагы аралык жана softmax температурасы */
  calib?: { typical: number; temperature: number };
}

/** templates.json индекси (tools/rsl_import/templates.ts) */
export interface TemplateIndex {
  version: number;
  n: number;
  dims: number;
  count: number;
  encoding: "int8";
  delta: boolean;
  scale: number[];
  glosses: string[];
  rows: number[];
  ids?: string[];
  features?: { n: number; dim: number; weights: Record<string, number>; version?: number; config?: Record<string, unknown> };
  calib?: { typical: number; temperature: number };
}

/** templates.json + templates.bin → TemplateBank. Белгилер бул кодго дал келбесе — ката. */
export function decodeTemplateBank(index: TemplateIndex, buf: ArrayBuffer): TemplateBank {
  const { n, dims: D, count: R } = index;
  if (n !== RESAMPLE_N || D !== FEATURE_DIM) throw new Error(`templates: ${n}×${D}, features.ts ${RESAMPLE_N}×${FEATURE_DIM}`);
  if (index.features?.weights) {
    for (const [k, v] of Object.entries(FEATURE_WEIGHTS)) {
      if (Math.abs((index.features.weights[k] ?? NaN) - v) > 1e-9) throw new Error(`templates: feature weight "${k}" differs — rebuild templates`);
    }
  }
  if ((index.features?.version ?? 1) !== FEATURE_VERSION) throw new Error(`templates: feature version ${index.features?.version ?? 1}, code ${FEATURE_VERSION} — rebuild templates`);
  if (index.features?.config) {
    for (const [k, v] of Object.entries(FEATURE_CONFIG)) {
      if (index.features.config[k] !== v) throw new Error(`templates: feature config "${k}" differs — rebuild templates`);
    }
  }
  const q = new Int8Array(buf);
  if (q.length !== R * n * D) throw new Error(`templates.bin: ${q.length} bytes, expected ${R * n * D}`);
  const data = new Float32Array(q.length);
  const scale = index.scale;
  const acc = new Int8Array(D);
  for (let r = 0; r < R; r++) {
    for (let i = 0; i < n; i++) {
      const o = (r * n + i) * D;
      for (let d = 0; d < D; d++) {
        // дельта модуль 256 боюнча (Int8Array өзү ороп алат)
        acc[d] = index.delta && i > 0 ? acc[d] + q[o + d] : q[o + d];
        data[o + d] = acc[d] * scale[d];
      }
    }
  }
  return { n, dims: D, glosses: index.glosses, rows: index.rows, data, ids: index.ids, calib: index.calib };
}

interface Template {
  cls: number;
  /** класстын аты (бириктирүүдө cls кайра эсептелет) */
  gloss: string;
  /** "bank" — китепкана, "user" — жаздыруу */
  origin: "bank" | "user";
  seq: Float32Array;
  /** LB_Keogh үчүн тилке боюнча жогорку/төмөнкү конверт */
  upper: Float32Array;
  lower: Float32Array;
  /** кадр боюнча колдун формасы нөлбү (zeroMask) */
  zero: Uint8Array;
  /** конверттин кол формасы блогу нөлбү (тилкедеги бардык кадрларда нөл) */
  envZero: Uint8Array;
}

const DEFAULTS: Required<ClassifierOptions> = {
  band: 0.2,
  k: 2,
  tempScale: 0.25,
  rejectRatio: 3.0,
  rejectSharpness: 4,
  leftHanded: false,
  handedness: "auto",
  userBias: 1,
  smooth: 0,
  mirrorAugment: false,
  minDurationMs: 150,
  minFrames: 4,
  softmaxMargin: 4,
};

export class SignClassifier {
  private opts: Required<ClassifierOptions>;
  private glosses: string[] = [];
  private templates: Template[] = [];
  /** Активдүү сөздүк (null — баары); колдонуучунун үлгүлөрү ар дайым активдүү */
  private vocab: Set<string> | null = null;
  private active = new Uint8Array(0);
  private hasUser = new Uint8Array(0);
  private userTemplates: Template[] = [];
  private bankTemplates: Template[] = [];
  private bankCalib: TemplateBank["calib"] | null = null;
  /** класс боюнча адаттагы ички аралык (LOO k-NN) */
  private typical = new Float32Array(0);
  private temperature = 1;
  private readonly n = RESAMPLE_N;
  private readonly D = FEATURE_DIM;
  private readonly r: number;
  // DTW үчүн кайра колдонулуучу буферлер
  private prev: Float64Array;
  private cur: Float64Array;

  constructor(opts: ClassifierOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.r = Math.max(1, Math.round(this.opts.band * this.n));
    this.prev = new Float64Array(this.n);
    this.cur = new Float64Array(this.n);
  }

  /** Активдүү (таанылуучу) глосстор */
  get vocabulary(): string[] {
    const v = this.vocab;
    return v ? this.glosses.filter((g, c) => v.has(g) || this.hasUser[c]) : this.glosses.slice();
  }

  /** Бардык белгилүү глосстор (активдүү эмес да) */
  get allGlosses(): string[] {
    return this.glosses.slice();
  }

  /**
   * Активдүү сөздүктү чектейт: ушул глосстор гана таанылат (null — баары). Колдонуучунун өз
   * үлгүлөрү бар глосстор ар дайым активдүү. Үлгүлөр өчүрүлбөйт — маска гана.
   */
  setVocabulary(glosses: Iterable<string> | null): void {
    this.vocab = glosses ? new Set(glosses) : null;
    this.remask();
  }

  /** Опцияларды өзгөртүү (мис. handedness) — үлгүлөр сакталат */
  configure(opts: ClassifierOptions): void {
    Object.assign(this.opts, opts);
  }

  private remask(): void {
    const T = this.templates.length;
    this.active = new Uint8Array(T);
    const v = this.vocab;
    for (let i = 0; i < T; i++) {
      const t = this.templates[i];
      this.active[i] = !v || t.origin === "user" || v.has(t.gloss) ? 1 : 0;
    }
  }

  get size(): number {
    return this.templates.length;
  }

  /** entry.samples боюнча окутат (колдонуучунун үлгүлөрү). Үлгүсү жок жазуулар эске алынбайт. Банк сакталат. */
  train(entries: SignEntry[]): void {
    const byGloss = new Map<string, MocapClip[]>();
    for (const e of entries) {
      if (!e.samples?.length) continue;
      const list = byGloss.get(e.gloss) ?? [];
      list.push(...e.samples);
      byGloss.set(e.gloss, list);
    }
    this.userTemplates = [];
    for (const [gloss, samples] of byGloss) {
      for (const s of samples) {
        if (!this.validClip(s)) continue;
        const variants = this.opts.mirrorAugment ? [false, true] : [false];
        for (const mirror of variants) {
          const seq = clipFeatures(s, { mirror });
          if (!seq) continue;
          this.userTemplates.push(this.makeTemplate(gloss, "user", seq));
        }
      }
    }
    this.rebuild();
  }

  /**
   * Китепкананын алдын ала эсептелген үлгүлөрүн кошот (мурунку банкты алмаштырат).
   * Колдонуучунун үлгүлөрү (train) сакталат. bank = null — банкты алып салуу.
   */
  addTemplates(bank: TemplateBank | null): void {
    this.bankTemplates = [];
    this.bankCalib = bank?.calib ?? null;
    if (bank) {
      if (bank.n !== this.n || bank.dims !== this.D) throw new Error("TemplateBank: n/dims дал келбейт");
      const size = this.n * this.D;
      for (let r = 0; r < bank.rows.length; r++) {
        const seq = bank.data.subarray(r * size, (r + 1) * size);
        const gloss = bank.glosses[bank.rows[r]];
        if (gloss) this.bankTemplates.push(this.makeTemplate(gloss, "bank", seq));
      }
    }
    this.rebuild();
  }

  /**
   * addTemplates'тин бөлүктөп иштеген версиясы: ар `chunk` үлгүдөн кийин башкы агымга жол берет
   * (телефондо интерфейс катып калбашы үчүн). Бүткөндө гана классификатор жаңырат.
   */
  async addTemplatesAsync(bank: TemplateBank | null, chunk = 120): Promise<void> {
    if (!bank) return this.addTemplates(null);
    if (bank.n !== this.n || bank.dims !== this.D) throw new Error("TemplateBank: n/dims дал келбейт");
    const size = this.n * this.D;
    const out: Template[] = [];
    for (let r = 0; r < bank.rows.length; r++) {
      const gloss = bank.glosses[bank.rows[r]];
      if (gloss) out.push(this.makeTemplate(gloss, "bank", bank.data.subarray(r * size, (r + 1) * size)));
      if (r % chunk === chunk - 1) await new Promise((res) => setTimeout(res, 0));
    }
    this.bankTemplates = out;
    this.bankCalib = bank.calib ?? null;
    this.rebuild();
  }

  /** Эки белги ырааттуулугунун DTW аралыгы (диагностика жана офлайн калибровка үчүн). */
  distance(a: Float32Array, b: Float32Array): number {
    return this.dtw(a, b);
  }

  /** Банктагы жана колдонуучунун үлгүлөрүнүн саны */
  get counts(): { bank: number; user: number } {
    return { bank: this.bankTemplates.length, user: this.userTemplates.length };
  }

  private rebuild(): void {
    this.glosses = [];
    const idx = new Map<string, number>();
    this.templates = [...this.userTemplates, ...this.bankTemplates];
    for (const t of this.templates) {
      let c = idx.get(t.gloss);
      if (c === undefined) {
        c = this.glosses.length;
        idx.set(t.gloss, c);
        this.glosses.push(t.gloss);
      }
      t.cls = c;
    }
    this.hasUser = new Uint8Array(this.glosses.length);
    for (const t of this.userTemplates) this.hasUser[t.cls] = 1;
    this.remask();
    this.calibrate();
  }

  /** Сегментти таанийт. Эч нерсе окутулбаса же сегмент өтө кыска болсо — null. */
  classify(clip: MocapClip, opts: ClassifyOptions = {}): Recognition | null {
    const d = this.classifyDetailed(clip, opts);
    return d ? toRecognition(d) : null;
  }

  /** Сегментти таанып, бардык активдүү класстардын аралыгын кайтарат (үйрөнүү/текшерүү үчүн). */
  classifyDetailed(clip: MocapClip, opts: ClassifyOptions = {}): DetailedRecognition | null {
    if (!this.templates.length || !this.validClip(clip)) return null;
    const auto = opts.mirror ?? this.dominantSide(clip);
    if (auto !== null) {
      const q = clipFeatures(clip, { mirror: auto, smooth: this.opts.smooth });
      return q ? this.rank(q, opts.include, auto, opts.maxDist, opts.topK, opts.coarse) : null;
    }
    // Негизги кол белгисиз (эки кол тең кыймылдайт): эки багытта тең салыштырып, жакыныраагын алабыз
    const q0 = clipFeatures(clip, { mirror: false, smooth: this.opts.smooth });
    const q1 = clipFeatures(clip, { mirror: true, smooth: this.opts.smooth });
    const r0 = q0 ? this.rank(q0, opts.include, false, opts.maxDist, opts.topK, opts.coarse) : null;
    const r1 = q1 ? this.rank(q1, opts.include, true, opts.maxDist, opts.topK, opts.coarse) : null;
    if (!r0) return r1;
    if (!r1) return r0;
    return r1.ranked[0].dist < r0.ranked[0].dist * 0.97 ? r1 : r0;
  }

  /** Даяр белги ырааттуулугун (N×D) иреттейт; include — активдүү сөздүктөн тышкары да каралуучу глосстор. */
  rankSequence(q: Float32Array, opts: { include?: Iterable<string>; mirrored?: boolean; maxDist?: number; topK?: number; coarse?: number } = {}): DetailedRecognition | null {
    return this.rank(q, opts.include, opts.mirrored ?? false, opts.maxDist, opts.topK, opts.coarse);
  }

  /** Банктын/колдонуучунун адаттагы ички аралыгы (четке кагуу чеги = rejectRatio × ушул) */
  get typicalDistance(): number {
    const prior = this.bankCalib?.typical;
    if (!this.glosses.length) return prior ?? 0.35;
    const xs = Array.from(this.typical).filter((v) => Number.isFinite(v) && v > 0);
    return xs.length ? median(xs) : prior ?? 0.35;
  }

  /**
   * Берилген глосстор үчүн так аралыктар (кесүүсүз): банк — эң жакын үлгү, колдонуучу — k-NN орточосу.
   * Белгисиз глосс — Infinity.
   */
  distancesFor(q: Float32Array, glosses: Iterable<string>, cutoff = Infinity): Map<string, number> {
    const out = new Map<string, number>();
    const want = new Set(glosses);
    const qz = zeroMask(q, this.n, this.D);
    const user = new Map<string, number[]>();
    const k = this.opts.k, bias = this.opts.userBias;
    for (const t of this.templates) {
      if (!want.has(t.gloss)) continue;
      // cutoff'тон алыс болсо — cutoff (так эмес, бирок DP үчүн жетиштүү)
      if (Number.isFinite(cutoff) && this.lbKeogh(q, t, qz, 4, cutoff) >= cutoff) { out.set(t.gloss, Math.min(out.get(t.gloss) ?? Infinity, cutoff)); continue; }
      let d = this.dtw(q, t.seq, cutoff, qz, t.zero);
      if (!Number.isFinite(d)) d = cutoff;
      if (t.origin === "bank") out.set(t.gloss, Math.min(out.get(t.gloss) ?? Infinity, d));
      else {
        const u = user.get(t.gloss) ?? [];
        insertSorted(u, d * bias, k);
        user.set(t.gloss, u);
      }
    }
    for (const [g, u] of user) {
      const m = u.reduce((a, b) => a + b, 0) / u.length;
      out.set(g, Math.min(out.get(g) ?? Infinity, m));
    }
    for (const g of want) if (!out.has(g)) out.set(g, Infinity);
    return out;
  }

  /** Сегментте кайсы кол негизги экенин аныктайт: "auto" режиминде сол кол болсо — күзгү (белгисиз → жок). */
  detectMirror(clip: MocapClip): boolean {
    return this.dominantSide(clip) ?? false;
  }

  /** true — сол кол негизги (күзгү), false — оң, null — белгисиз (эки кол тең кыймылдайт) */
  detectSide(clip: MocapClip): boolean | null {
    return this.dominantSide(clip);
  }

  /** Четке кагуу параметрлери (декодер ушуну колдонот) */
  get rejection(): { ratio: number; sharpness: number; temperature: number } {
    return { ratio: this.opts.rejectRatio, sharpness: this.opts.rejectSharpness, temperature: this.temperature };
  }

  /** true — күзгүлөө керек (сол кол негизги), false — жок, null — белгисиз (эки кол тең) */
  private dominantSide(clip: MocapClip): boolean | null {
    const h = this.opts.handedness;
    if (h === "left") return true;
    if (h === "right") return false;
    if (this.opts.leftHanded) return true;
    // Негизги кол — көбүрөөк кыймылдаган кол (pose билегинин жолунун узундугу + кол формасынын
    // өзгөрүшү); бир колдуу жестте — көрүнгөн кол. Сол кол ачык эле негизги болсо — күзгү.
    let lPath = 0, rPath = 0, lSeen = 0, rSeen = 0;
    let prev: MocapFrame | null = null;
    for (const f of clip.frames) {
      if (f.leftHand) lSeen++;
      if (f.rightHand) rSeen++;
      if (prev && f.pose && prev.pose && f.pose.length > 16 && prev.pose.length > 16) {
        const d = (i: number) => Math.hypot(f.pose![i][0] - prev!.pose![i][0], f.pose![i][1] - prev!.pose![i][1], f.pose![i][2] - prev!.pose![i][2]);
        if (f.leftHand && prev.leftHand) lPath += d(15) + 0.3 * handDelta(f.leftHand, prev.leftHand);
        if (f.rightHand && prev.rightHand) rPath += d(16) + 0.3 * handDelta(f.rightHand, prev.rightHand);
      }
      prev = f;
    }
    if (!lSeen) return false;
    if (!rSeen) return true;
    if (rSeen < 0.35 * lSeen) return true;
    if (lSeen < 0.35 * rSeen) return false;
    if (lPath > 2.5 * rPath && lPath > 0.05) return true;
    if (rPath > 2.5 * lPath) return false;
    return null;
  }

  /** Даяр белги ырааттуулугу (N×D) боюнча таануу. */
  classifySequence(q: Float32Array): Recognition | null {
    const d = this.rank(q, undefined, false);
    return d ? toRecognition(d) : null;
  }

  private rank(q: Float32Array, include: Iterable<string> | undefined, mirrored: boolean, maxDist = Infinity, topK = 0, coarse = 0): DetailedRecognition | null {
    const C = this.glosses.length;
    if (!C) return null;
    // topK берилсе: так эсептелген класстардын K-чы эң жакшы аралыгы да кесүү чеги (DP үчүн жетиштүү)
    const kth: number[] = [];
    const kthCut = () => (topK > 0 && kth.length >= topK ? kth[topK - 1] : Infinity);
    let active = this.active;
    if (include) {
      const inc = new Set(include);
      if (inc.size) {
        active = active.slice();
        for (let i = 0; i < active.length; i++) if (inc.has(this.templates[i].gloss)) active[i] = 1;
      }
    }
    const userBias = this.opts.userBias;
    const k = this.opts.k;
    // Колдонуучунун үлгүлөрү: класс боюнча эң жакын k аралык (өсүү тартибинде) — k-NN орточо.
    // Китепкана: класстын эң жакын үлгүсү (бир глосстун варианттары башка-башка жест болушу мүмкүн,
    // ошондуктан алардын орточосу эмес, минимуму алынат).
    const user: number[][] = Array.from({ length: C }, () => []);
    const bankBest = new Float64Array(C).fill(Infinity);
    // LB боюнча иреттеп, жакындарын биринчи эсептейбиз — кесүү натыйжалуураак болот
    const T = this.templates.length;
    const qz = zeroMask(q, this.n, this.D);
    // 1-баскыч: ар 4-кадр боюнча жарым LB_Keogh (бул да төмөнкү чек) — бардык үлгүлөр үчүн арзан;
    // 2-баскыч: ошол тартипте толук LB (эрте токтотуу менен), андан кийин гана DTW.
    const lb0 = new Float64Array(T);
    const order = new Array<number>(T);
    let nAct = 0;
    if (coarse > 0) {
      // 1-баскыч: орун белгилери боюнча арзан DTW → эң жакын `coarse` үлгү (колдонуучунун үлгүлөрү,
      // кошулган (include) глосстор ар дайым калат)
      const inc = include ? new Set(include) : null;
      const cd = new Float64Array(T).fill(Infinity);
      const cand: number[] = [];
      for (let i = 0; i < T; i++) {
        if (!active[i]) continue;
        const t = this.templates[i];
        if (t.origin === "user" || (inc && inc.has(t.gloss))) { cd[i] = -1; cand.push(i); continue; }
        cd[i] = this.dtwDense(q, t.seq);
        cand.push(i);
      }
      cand.sort((a, b) => cd[a] - cd[b]);
      // бир глосстун бир нече үлгүсү болсо, эң жакшысы гана саналат — глосс боюнча `coarse`
      const seen = new Set<string>();
      for (const i of cand) {
        const t = this.templates[i];
        if (cd[i] >= 0 && seen.size >= coarse && !seen.has(t.gloss)) { active = active === this.active ? active.slice() : active; active[i] = 0; continue; }
        seen.add(t.gloss);
      }
    }
    for (let i = 0; i < T; i++) {
      if (!active[i]) continue;
      lb0[i] = this.lbKeogh(q, this.templates[i], qz, 4);
      if (this.templates[i].origin === "user") lb0[i] *= userBias;
      order[nAct++] = i;
    }
    order.length = nAct;
    // Жарым LB 8 кадр боюнча — бардык 32 кадрдагы чекке болжол менен ×4; тартип ошол боюнча
    // (кесүү үчүн чыныгы чек lb0 колдонулат). Тартип кайсы болсо да жыйынтык ошол эле.
    order.sort((a, b) => lb0[a] - lb0[b]);
    let globalBest = Infinity;
    // softmax'та салымы < e^-margin болгон класстарды так эсептөөнүн кереги жок
    const margin = this.opts.softmaxMargin * this.temperature;
    const exact = new Uint8Array(C);
    const approx = (t: Template, v: number) => {
      if (t.origin === "bank") bankBest[t.cls] = Math.min(bankBest[t.cls], v);
      else if (user[t.cls].length < k) insertSorted(user[t.cls], v, k);
    };
    for (const i of order) {
      const t = this.templates[i];
      const isBank = t.origin === "bank";
      const u = user[t.cls];
      const classCut = isBank ? bankBest[t.cls] : u.length < k ? Infinity : u[k - 1];
      if (lb0[i] >= classCut) continue;
      const hardCut = Math.min(maxDist, globalBest + margin, kthCut());
      if (lb0[i] >= hardCut) {
        // Бул үлгү эч качан жеңбейт; аралыгы катары төмөнкү чекти жазабыз (салымы ~0)
        approx(t, Math.max(lb0[i], hardCut));
        continue;
      }
      const cutoff = Math.min(classCut, hardCut);
      const lb = this.lbKeogh(q, t, qz, 1, isBank ? cutoff : cutoff / userBias) * (isBank ? 1 : userBias);
      if (lb >= cutoff) {
        approx(t, Math.max(lb0[i], cutoff));
        continue;
      }
      let d = this.dtw(q, t.seq, isBank ? cutoff : cutoff / userBias, qz, t.zero);
      if (!isBank) d *= userBias;
      if (Number.isFinite(d)) {
        if (!exact[t.cls] && topK > 0) insertSorted(kth, d, topK);
        exact[t.cls] = 1;
      }
      const dd = Number.isFinite(d) ? d : Math.max(lb, cutoff);
      if (isBank) bankBest[t.cls] = Math.min(bankBest[t.cls], dd);
      else insertSorted(u, dd, k);
      if (dd < globalBest) globalBest = dd;
    }
    const dist = new Float64Array(C);
    for (let c = 0; c < C; c++) {
      const b = user[c];
      let d = bankBest[c];
      if (b.length) {
        let s = 0;
        for (const v of b) s += v;
        d = Math.min(d, s / b.length);
      }
      // так эсептелбеген класс (төмөнкү чек гана) — ал margin'ден алыс экени белгилүү;
      // активдүү эмес класс (эч бир үлгүсү каралган жок) — Infinity
      dist[c] = exact[c] ? d : Number.isFinite(d) ? Math.max(d, Math.min(globalBest + margin, maxDist, kthCut())) : Infinity;
    }
    // softmax
    let dmin = Infinity, imin = 0;
    for (let c = 0; c < C; c++) if (dist[c] < dmin) { dmin = dist[c]; imin = c; }
    const probs = new Float64Array(C);
    let Z = 0;
    // Кесилген softmax: margin'ден алыс класстар (алардын аралыгы көбүнчө так эсептелген эмес,
    // төмөнкү чек гана) эске алынбайт — ар биринин салымы < e^-softmaxMargin.
    for (let c = 0; c < C; c++) {
      const x = dist[c] - dmin;
      const p = exact[c] && x < margin ? Math.exp(-x / this.temperature) : 0;
      probs[c] = p; Z += p;
    }
    // четке кагуу: класстын адаттагы ички аралыгына салыштыруу
    const ratio = dmin / this.typical[imin];
    const accept = 1 / (1 + Math.exp((ratio - this.opts.rejectRatio) * this.opts.rejectSharpness));
    const ranked: number[] = [];
    for (let c = 0; c < C; c++) if (Number.isFinite(dist[c])) ranked.push(c);
    ranked.sort((a, b) => dist[a] - dist[b]);
    if (!ranked.length) return null;
    // эч бир класс так эсептелген жок (баары maxDist'тен алыс) — ишеним 0, аралыктар чек боюнча
    const conf = (c: number) => (Z > 0 ? round3((probs[c] / Z) * accept) : 0);
    return {
      ranked: ranked.map((c) => ({ gloss: this.glosses[c], dist: dist[c], confidence: conf(c), exact: !!exact[c] })),
      ratio,
      mirrored,
    };
  }

  /** Класстын адаттагы ички аралыгы (четке кагуу чеги ушуга карата) */
  typicalFor(gloss: string): number {
    const c = this.glosses.indexOf(gloss);
    return c < 0 ? NaN : this.typical[c];
  }

  /** Диагностика: акыркы калибровканын маанилери. */
  get stats(): { temperature: number; typical: Record<string, number> } {
    const typical: Record<string, number> = {};
    this.glosses.forEach((g, i) => (typical[g] = this.typical[i]));
    return { temperature: this.temperature, typical };
  }

  // ───────────────────────── ички ─────────────────────────

  private validClip(c: MocapClip): boolean {
    const f = c.frames;
    if (!f || f.length < this.opts.minFrames) return false;
    if (f[f.length - 1].t - f[0].t < this.opts.minDurationMs) return false;
    return f.some((x) => x.leftHand || x.rightHand);
  }

  private makeTemplate(gloss: string, origin: Template["origin"], seq: Float32Array): Template {
    const { n, D, r } = this;
    const zero = zeroMask(seq, n, D);
    const envZero = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let m = 3;
      for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) m &= zero[j];
      envZero[i] = m;
    }
    // Конверт тилке боюнча; тилкенин бардык кадрларында нөл болгон кол формасы блогу — нөл бойдон
    // (Float32Array демейки 0), эсептелбейт.
    const upper = new Float32Array(n * D);
    const lower = new Float32Array(n * D);
    const env = (o: number, lo: number, hi: number, d0: number, d1: number) => {
      for (let d = d0; d < d1; d++) {
        let u = -Infinity, l = Infinity;
        for (let j = lo, p = lo * D + d; j <= hi; j++, p += D) {
          const v = seq[p];
          if (v > u) u = v;
          if (v < l) l = v;
        }
        upper[o + d] = u;
        lower[o + d] = l;
      }
    };
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
      const o = i * D;
      let d = 0;
      for (let h = 0; h < 2; h++) {
        const s0 = SHAPE_OFF[h];
        env(o, lo, hi, d, s0); // presence (+ мурунку колдун орду)
        if (!(envZero[i] & (1 << h))) env(o, lo, hi, s0, s0 + SHAPE_LEN);
        d = s0 + SHAPE_LEN;
      }
      env(o, lo, hi, d, D);
    }
    return { cls: -1, gloss, origin, seq, upper, lower, zero, envZero };
  }

  /** LB_Keogh: DTW аралыгынын төмөнкү чеги (ошол эле нормалдаштыруу менен). */
  private lbKeogh(q: Float32Array, t: Template, qz: Uint8Array, stride = 1, cutoff = Infinity): number {
    const { n, D } = this;
    const U = t.upper, L = t.lower, ez = t.envZero;
    const limit = cutoff * n;
    let sum = 0;
    for (let i = 0; i < n; i += stride) {
      const o = i * D;
      let s = 0;
      for (let k = 0; k < DENSE_DIMS.length; k++) {
        const d = o + DENSE_DIMS[k];
        const v = q[d];
        if (v > U[d]) { const e = v - U[d]; s += e * e; } else if (v < L[d]) { const e = L[d] - v; s += e * e; }
      }
      const skip = qz[i] & ez[i];
      for (let h = 0; h < 2; h++) {
        if (skip & (1 << h)) continue;
        const b = o + SHAPE_OFF[h], e2 = b + SHAPE_LEN;
        for (let d = b; d < e2; d++) {
          const v = q[d];
          if (v > U[d]) { const e = v - U[d]; s += e * e; } else if (v < L[d]) { const e = L[d] - v; s += e * e; }
        }
      }
      sum += Math.sqrt(s);
      if (sum > limit) return Infinity;
    }
    return sum / n;
  }

  /** Орун белгилери (DENSE_DIMS: бар-жок + билек + чыканак) боюнча гана DTW — арзан алдын ала издөө. */
  private dtwDense(a: Float32Array, b: Float32Array): number {
    const { n, D, r } = this;
    let prev = this.prev, cur = this.cur;
    prev.fill(Infinity);
    const K = DENSE_DIMS.length;
    for (let i = 0; i < n; i++) {
      cur.fill(Infinity);
      const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
      const ao = i * D;
      for (let j = lo; j <= hi; j++) {
        const bo = j * D;
        let s = 0;
        for (let k = 0; k < K; k++) { const d = DENSE_DIMS[k]; const e = a[ao + d] - b[bo + d]; s += e * e; }
        let m: number;
        if (i === 0 && j === 0) m = 0;
        else {
          m = prev[j];
          if (j > 0) {
            if (cur[j - 1] < m) m = cur[j - 1];
            if (prev[j - 1] < m) m = prev[j - 1];
          }
        }
        cur[j] = Math.sqrt(s) + m;
      }
      const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n - 1] / n;
  }

  /** Sakoe-Chiba тилкеси менен DTW. Сап минимуму cutoff'тон ашса — Infinity (эрте токтотуу). */
  private dtw(a: Float32Array, b: Float32Array, cutoff = Infinity, az?: Uint8Array, bz?: Uint8Array): number {
    const { n, D, r } = this;
    az ??= zeroMask(a, n, D);
    bz ??= zeroMask(b, n, D);
    let prev = this.prev, cur = this.cur;
    const limit = cutoff * n;
    prev.fill(Infinity);
    for (let i = 0; i < n; i++) {
      cur.fill(Infinity);
      const lo = Math.max(0, i - r), hi = Math.min(n - 1, i + r);
      const ao = i * D;
      let rowMin = Infinity;
      for (let j = lo; j <= hi; j++) {
        const bo = j * D;
        let s = 0;
        for (let k = 0; k < DENSE_DIMS.length; k++) { const d = DENSE_DIMS[k]; const e = a[ao + d] - b[bo + d]; s += e * e; }
        const skip = az[i] & bz[j];
        if (!(skip & 1)) for (let d = SHAPE_OFF[0], e2 = d + SHAPE_LEN; d < e2; d++) { const e = a[ao + d] - b[bo + d]; s += e * e; }
        if (!(skip & 2)) for (let d = SHAPE_OFF[1], e2 = d + SHAPE_LEN; d < e2; d++) { const e = a[ao + d] - b[bo + d]; s += e * e; }
        const cost = Math.sqrt(s);
        let m: number;
        if (i === 0 && j === 0) m = 0;
        else {
          m = prev[j]; // (i-1, j)
          if (j > 0) {
            if (cur[j - 1] < m) m = cur[j - 1]; // (i, j-1)
            if (prev[j - 1] < m) m = prev[j - 1]; // (i-1, j-1)
          }
        }
        const v = cost + m;
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > limit) return Infinity;
      const tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n - 1] / n;
  }

  /** Класстардын адаттагы ички аралыгын (leave-one-out k-NN) жана температураны эсептейт. */
  private calibrate(): void {
    const C = this.glosses.length;
    this.typical = new Float32Array(C);
    if (!C) return;
    // Ички аралык колдонуучунун үлгүлөрү боюнча гана эсептелет: китепкананын бир глосстогу
    // варианттары көбүнчө башка-башка жесттер, алар "адаттагы" аралыкты бузат.
    const byCls: Template[][] = Array.from({ length: C }, () => []);
    for (const t of this.templates) if (t.origin === "user") byCls[t.cls].push(t);
    const k = this.opts.k;
    const known: number[] = [];
    const values = new Float64Array(C).fill(NaN);
    for (let c = 0; c < C; c++) {
      const ts = byCls[c];
      if (ts.length < 2) continue;
      const m = ts.length;
      const D2 = new Float64Array(m * m);
      for (let i = 0; i < m; i++)
        for (let j = i + 1; j < m; j++) D2[i * m + j] = D2[j * m + i] = this.dtw(ts[i].seq, ts[j].seq, Infinity, ts[i].zero, ts[j].zero);
      let acc = 0;
      for (let i = 0; i < m; i++) {
        const row: number[] = [];
        for (let j = 0; j < m; j++) if (j !== i) row.push(D2[i * m + j]);
        row.sort((x, y) => x - y);
        const kk = Math.min(k, row.length);
        let s = 0;
        for (let q = 0; q < kk; q++) s += row[q];
        acc += s / kk;
      }
      values[c] = acc / m;
      known.push(values[c]);
    }
    const prior = this.bankTemplates.length ? this.bankCalib ?? { typical: 0.35, temperature: 0.09 } : null;
    let global: number;
    if (known.length) {
      global = median(known);
    } else if (prior) {
      global = prior.typical;
    } else {
      // Бир дагы класста 2 үлгү жок: класстар аралык эң жакын аралыктын жарымын алабыз
      const all: Template[][] = Array.from({ length: C }, () => []);
      for (const t of this.templates) all[t.cls].push(t);
      const inter: number[] = [];
      for (let c = 0; c < C; c++) {
        let m = Infinity;
        for (const t of this.templates) if (t.cls !== c) m = Math.min(m, this.dtw(all[c][0].seq, t.seq, Infinity, all[c][0].zero, t.zero));
        if (Number.isFinite(m)) inter.push(m);
      }
      global = inter.length ? 0.5 * median(inter) : 0.5;
    }
    if (!(global > 1e-6)) global = 0.5;
    const hasUser = new Uint8Array(C);
    for (const t of this.userTemplates) hasUser[t.cls] = 1;
    for (let c = 0; c < C; c++) {
      const v = values[c];
      // кичине класстар (2-3 үлгү) бирдей болуп калса, ашыкча катуу болбосун
      this.typical[c] = Number.isFinite(v) ? Math.max(v, 0.6 * global) : hasUser[c] || !prior ? global : prior.typical;
    }
    this.temperature = prior ? prior.temperature : this.opts.tempScale * global;
  }
}

/** Эки кадрдын ортосундагы манжа учтарынын орточо жылышы (билекке салыштырмалуу), м */
function handDelta(a: Vec3[], b: Vec3[]): number {
  let s = 0;
  for (const k of [4, 8, 12, 16, 20]) s += Math.hypot(a[k][0] - a[0][0] - (b[k][0] - b[0][0]), a[k][1] - a[0][1] - (b[k][1] - b[0][1]), a[k][2] - a[0][2] - (b[k][2] - b[0][2]));
  return s / 5;
}

function toRecognition(d: DetailedRecognition): Recognition {
  const r = d.ranked;
  return {
    gloss: r[0].gloss,
    confidence: r[0].confidence,
    alternatives: r.slice(1, 5).map((c) => ({ gloss: c.gloss, confidence: c.confidence })),
  };
}

function insertSorted(arr: number[], v: number, k: number): void {
  let i = arr.length;
  while (i > 0 && arr[i - 1] > v) i--;
  if (i >= k) return;
  arr.splice(i, 0, v);
  if (arr.length > k) arr.length = k;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
