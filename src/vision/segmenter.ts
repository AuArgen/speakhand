// Үзгүлтүксүз жест агымын өзүнчө жесттерге бөлүү (streaming segmentation) жана клип жаздыргыч.
//
// Эвристика:
//   • "Активдүү" кадр: жок дегенде бир кол көрүнөт ЖАНА анын билеги "эс алуу зонасынан"
//     жогору (жамбаш менен ийиндин ортосундагы деңгээлден өйдө) же ал тез кыймылдап жатат.
//   • Сегмент активдүү кадрлар катары менен келгенде башталат (бир аз күтүү менен).
//   • Сегмент колдор restMs бою түшүрүлсө/жоголсо, же кыймыл stillMs бою дээрлик токтосо бүтөт
//     (кармоо — hold). Токтоп калгандан кийин жаңы сегмент колдор кайра кыймылдаганда гана башталат.
//   • Аягындагы бош кадрлар кесилет; minMs'тен кыска сегменттер ташталат; maxMs'те бөлүнөт.
//   • peek() — учурдагы (бүтө элек) сегменттин кадрлары: алдын ала болжолдоо үчүн.

import type { MocapClip, MocapFrame, Vec3 } from "../lib/types";
import { POSE } from "./features";

export interface SegmenterOptions {
  /** Мындан кыска сегменттер ташталат, мс (демейки 300) */
  minMs?: number;
  /** Сегменттин эң чоң узундугу, мс (демейки 4000) */
  maxMs?: number;
  /** Колдор ушунча убакыт түшүрүлсө / жоголсо — сегмент бүттү, мс (демейки 300) */
  restMs?: number;
  /** Колдор абада, бирок кыймыл ушунча убакыт токтосо — сегмент бүттү, мс (демейки 250; endOnStill) */
  stillMs?: number;
  /** Кыймыл энергиясынын "токтоду" чеги, ийин туурасы/сек (демейки 0.35) */
  stillThreshold?: number;
  /** Кайра башталуу үчүн керектүү кыймыл энергиясы, ийин туурасы/сек (демейки 0.7) */
  startThreshold?: number;
  /** Эс алуу зонасынын чеги: жамбаш(0)…ийин(1) аралыгындагы үлүш (демейки 0.3) */
  restLevel?: number;
  /** Кыймыл токтогондо да сегментти бүтүрүү (демейки true) */
  endOnStill?: boolean;
  /** Активдүүлүк башталышы үчүн катары менен келген кадрлар (демейки 2) */
  startFrames?: number;
  /** Кыймыл энергиясын эсептөөчү терезе, мс (демейки 200) */
  motionWindowMs?: number;
}

const DEF: Required<SegmenterOptions> = {
  minMs: 250,
  maxMs: 4000,
  restMs: 300,
  stillMs: 250,
  stillThreshold: 0.35,
  startThreshold: 0.7,
  restLevel: 0.3,
  endOnStill: true,
  startFrames: 2,
  motionWindowMs: 200,
};

/** Аягында сакталуучу кыймылсыз кармоонун узундугу, мс */
const HOLD_KEEP_MS = 200;

/** Кадрдын кошумча маалыматы (сүрөттөгү көрүнүү ишеними ж.б.) */
export interface FrameAux {
  /** pose чекиттеринин көрүнүү ишеними (MediaPipe visibility, 33) */
  vis?: ArrayLike<number> | null;
}

export interface FrameActivity {
  /** жок дегенде бир кол көрүнөт жана эс алуу зонасынан жогору */
  raised: boolean;
  /** кыймыл энергиясы, ийин туурасы / сек (жылмаланган) */
  energy: number;
}

export class SignSegmenter {
  private o: Required<SegmenterOptions>;
  private buf: MocapFrame[] = [];
  private inside = false;
  /** Башталуу үчүн кыймыл керек (эс алып турган кол сүйлөмдү баштабайт) */
  private armed = false;
  private streak = 0;
  private lastRaisedT = -Infinity;
  private lastMovingT = -Infinity;
  private startT = 0;
  private meter: MotionMeter;
  private rest: RestTracker;
  private lastActivity: FrameActivity = { raised: false, energy: 0 };
  /** сегмент башталганга чейинки акыркы кадр (интерполяция үчүн) */
  private preRoll: MocapFrame | null = null;
  /** акыркы кайтарылган сегменттин биринчи кадрынын абсолюттук убактысы */
  private lastT0 = NaN;

  constructor(opts: SegmenterOptions = {}) {
    this.o = { ...DEF, ...opts };
    this.meter = new MotionMeter(this.o.motionWindowMs);
    this.rest = new RestTracker({ restLevel: this.o.restLevel, stillThreshold: this.o.stillThreshold });
  }

  /** Эс алуу деңгээлин үйрөнгүч (декодер менен бөлүшүү үчүн) */
  get restTracker(): RestTracker {
    return this.rest;
  }

  get active(): boolean {
    return this.inside;
  }

  /** Акыркы кадрдын активдүүлүгү (UI индикатору үчүн) */
  get activity(): FrameActivity {
    return this.lastActivity;
  }

  reset(): void {
    this.buf = [];
    this.inside = false;
    this.armed = false;
    this.streak = 0;
    this.lastRaisedT = this.lastMovingT = -Infinity;
    this.meter.reset();
    this.rest.reset();
    this.preRoll = null;
    this.lastActivity = { raised: false, energy: 0 };
  }

  /** Учурдагы (бүтө элек) сегменттин кадрлары; сегмент жок болсо — бош. */
  peek(): MocapFrame[] {
    return this.inside ? this.buf : [];
  }

  /** Учурдагы сегменттин башталышы (кадр убактысы) */
  get startedAt(): number {
    return this.inside ? this.startT : NaN;
  }

  /** Акыркы кайтарылган клиптин биринчи кадрынын абсолюттук убактысы (клипте t 0дөн башталат) */
  get lastSegmentStart(): number {
    return this.lastT0;
  }

  /** Кадр кошот. Сегмент бүтсө — аны клип катары кайтарат (t 0дөн башталат). */
  push(frame: MocapFrame, aux?: FrameAux): MocapClip | null {
    const act = this.measure(frame, aux);
    this.lastActivity = act;
    const t = frame.t;
    const o = this.o;
    const moving = act.energy > o.stillThreshold;
    const visible = !!(frame.leftHand || frame.rightHand);

    if (!this.inside) {
      // Колдор түшсө же кайра тез кыймылдаса — кайрадан башталууга даяр
      if (!act.raised || act.energy > o.startThreshold) this.armed = true;
      this.streak = act.raised && this.armed ? this.streak + 1 : 0;
      if (this.streak >= o.startFrames) {
        this.inside = true;
        this.startT = t;
        this.buf = this.preRoll ? [this.preRoll, frame] : [frame];
        this.lastRaisedT = t;
        this.lastMovingT = t;
        this.streak = 0;
        return null;
      }
      this.preRoll = frame;
      return null;
    }

    this.buf.push(frame);
    if (act.raised) this.lastRaisedT = t;
    if (moving && visible) this.lastMovingT = t;

    if (t - this.lastRaisedT >= o.restMs) {
      // Колдор түшүрүлдү / жоголду
      this.armed = true;
      return this.finish(this.lastRaisedT);
    }
    if (o.endOnStill && t - this.lastMovingT >= o.stillMs) {
      // Колдор абада, бирок кыймыл токтоду
      this.armed = false;
      return this.finish(Math.min(t, this.lastMovingT + HOLD_KEEP_MS));
    }
    if (t - this.startT >= o.maxMs) {
      this.armed = true;
      return this.finish(t);
    }
    return null;
  }

  /** Учурдагы сегментти мажбурлап бүтүрөт (мис. камера өчкөндө). */
  flush(): MocapClip | null {
    if (!this.inside) return null;
    return this.finish(this.lastRaisedT);
  }

  private finish(endT: number): MocapClip | null {
    const frames = this.buf.filter((f) => f.t <= endT);
    this.buf = [];
    this.inside = false;
    this.rest.resetUtterance();
    this.streak = 0;
    this.preRoll = null;
    // Башындагы колу жок кадрларды кесүү
    let s = 0;
    while (s < frames.length - 1 && !frames[s].leftHand && !frames[s].rightHand) s++;
    const trimmed = frames.slice(s);
    if (trimmed.length < 2) return null;
    const dur = trimmed[trimmed.length - 1].t - trimmed[0].t;
    if (dur < this.o.minMs) return null;
    this.lastT0 = trimmed[0].t;
    return toClip(trimmed);
  }

  /** Кадрдын активдүүлүгүн жана кыймыл энергиясын эсептейт. */
  private measure(f: MocapFrame, aux?: FrameAux): FrameActivity {
    const m = this.meter.push(f);
    const raised = this.rest.push(f, m.energy, m.scale, aux?.vis) || (m.energy > 2 * this.o.startThreshold && !!(f.leftHand || f.rightHand));
    return { raised, energy: m.energy };
  }
}

/** Көрүнгөн билектердин эң бийигинин деңгээли: 0 = жамбаш, 1 = ийин; кол жок болсо NaN */
export function wristLevel(f: MocapFrame, scale: number, vis?: ArrayLike<number> | null): number {
  const pose = f.pose && f.pose.length > 24 ? f.pose : null;
  if (!f.leftHand && !f.rightHand) return NaN;
  if (!pose) return Infinity; // pose жок — кол көрүнсө, көтөрүлгөн деп эсептейбиз
  const l = pose[POSE.L_SHOULDER], r = pose[POSE.R_SHOULDER];
  const shY = (l[1] + r[1]) / 2;
  // Отурган адамда жамбаш кадрда жок болушу мүмкүн — анда эс алуу зонасы ийинден эсептелет
  const hipsVisible = !vis || Math.max(vis[POSE.L_HIP] ?? 1, vis[POSE.R_HIP] ?? 1) > 0.5;
  const hipY = hipsVisible ? (pose[POSE.L_HIP][1] + pose[POSE.R_HIP][1]) / 2 : shY - 1.4 * scale;
  const h = shY - hipY || 1;
  let best = -Infinity;
  if (f.leftHand) best = Math.max(best, (pose[POSE.L_WRIST][1] - hipY) / h);
  if (f.rightHand) best = Math.max(best, (pose[POSE.R_WRIST][1] - hipY) / h);
  return best;
}

/**
 * Жок дегенде бир кол көрүнөт ЖАНА анын билеги эс алуу зонасынан жогорубу (жамбаш(0)…ийин(1)
 * аралыгындагы restLevel үлүшүнөн өйдө). scale — ийин туурасы (м); vis — pose көрүнүү ишеними.
 * Абалсыз версия; адамга ылайыкташкан версиясы — RestTracker.
 */
export function isRaised(f: MocapFrame, scale: number, restLevel = DEF.restLevel, vis?: ArrayLike<number> | null): boolean {
  const lvl = wristLevel(f, scale, vis);
  return Number.isFinite(lvl) ? lvl > restLevel : lvl === Infinity;
}

export interface RestTrackerOptions {
  /** Эс алуу чеги (жамбаш 0 … ийин 1), демейки 0.3 */
  restLevel?: number;
  /** Кыймылсыздык чеги (энергия), демейки 0.35 */
  stillThreshold?: number;
  /** Колдор ушунча убакыт кыймылсыз ЖАНА төмөн турса — эс алуу, мс (демейки 300) */
  stillRestMs?: number;
  /** "Төмөн": ушул сүйлөмдөгү эң бийик деңгээлдин ушул үлүшүнөн төмөн (демейки 0.6) жана 0.75тен төмөн */
  lowRatio?: number;
}

/**
 * "Кол көтөрүлгөнбү" аныктагыч. Эки эреже:
 *   1. билек эс алуу сызыгынан (restLevel) төмөн же кол көрүнбөйт — эс алуу;
 *   2. кээ бир адамдар колун столго / курсагынын алдына коюп эс алат (жамбашка карата бийик):
 *      колдор ≥ stillRestMs кыймылсыз ЖАНА ушул сүйлөмдөгү эң бийик деңгээлден бир топ төмөн
 *      (lowRatio) турса — эс алуу. Сүйлөм бүткөндө resetUtterance() чакырылат.
 * Ушул эле эреже сегментаторго, декодерге жана тесттерге кызмат кылат.
 */
export class RestTracker {
  private stillSince = -Infinity;
  private maxLevel = 0;
  private o: Required<RestTrackerOptions>;
  constructor(opts: RestTrackerOptions = {}) {
    this.o = { restLevel: DEF.restLevel, stillThreshold: DEF.stillThreshold, stillRestMs: 300, lowRatio: 0.6, ...opts };
  }

  reset(): void {
    this.stillSince = -Infinity;
    this.maxLevel = 0;
  }

  /** Жаңы сүйлөм: эң бийик деңгээл кайра эсептелет */
  resetUtterance(): void {
    this.maxLevel = 0;
  }

  /** Учурдагы сүйлөмдөгү эң бийик билек деңгээли */
  get peak(): number {
    return this.maxLevel;
  }

  push(f: MocapFrame, energy: number, scale: number, vis?: ArrayLike<number> | null): boolean {
    const lvl = wristLevel(f, scale, vis);
    if (Number.isNaN(lvl)) { this.stillSince = -Infinity; return false; }
    if (lvl === Infinity) return true;
    if (energy < this.o.stillThreshold) {
      if (this.stillSince === -Infinity) this.stillSince = f.t;
    } else this.stillSince = -Infinity;
    if (lvl <= this.o.restLevel) return false;
    if (lvl > this.maxLevel) this.maxLevel = lvl;
    const stillLow = this.stillSince !== -Infinity && f.t - this.stillSince >= this.o.stillRestMs && lvl < 0.75 && lvl < this.o.lowRatio * this.maxLevel;
    return !stillLow;
  }
}

/**
 * Кыймыл энергиясынын өлчөгүчү: учурдагы кадрды ~windowMs мурдагы кадр менен салыштырат
 * (билектин ылдамдыгы ийин туурасы/сек + манжалардын формасынын өзгөрүшү), EMA менен жылмаланат.
 * Сегментатор жана сүйлөм декодери (decoder.ts) бирдей колдонот.
 */
export class MotionMeter {
  private hist: MotionSample[] = [];
  private energy = 0;
  constructor(private windowMs = 200) {}

  reset(): void {
    this.hist = [];
    this.energy = 0;
  }

  /** @returns energy — жылмаланган кыймыл энергиясы; scale — ийин туурасы (м) */
  push(f: MocapFrame): { energy: number; scale: number } {
    const pose = f.pose && f.pose.length > 24 ? f.pose : null;
    const hands = [f.leftHand, f.rightHand];
    const wristIdx = [POSE.L_WRIST, POSE.R_WRIST];
    let scale = 0.35; // ийин туурасы, м (pose жок болсо болжолдуу)
    if (pose) {
      const l = pose[POSE.L_SHOULDER], r = pose[POSE.R_SHOULDER];
      scale = Math.hypot(l[0] - r[0], l[1] - r[1], l[2] - r[2]) || scale;
    }
    // Кадр сайын айырма алуудан айырмаланып, ызы-чуу терезе узундугуна бөлүнүп азаят.
    const cur: MotionSample = {
      t: f.t,
      wrist: [0, 1].map((h) => (hands[h] && pose ? pose[wristIdx[h]] : null)),
      shape: hands.map((hd) => (hd && hd.length >= 21 ? tipShape(hd) : null)),
    };
    const W = this.windowMs;
    const hist = this.hist;
    while (hist.length > 1 && (f.t - hist[1].t >= W || f.t < hist[hist.length - 1].t)) hist.shift();
    const ref = hist[0];
    let e = 0;
    if (ref && f.t > ref.t && f.t - ref.t < 3 * W) {
      const dt = (f.t - ref.t) / 1000;
      for (let h = 0; h < 2; h++) {
        const p = cur.wrist[h], q = ref.wrist[h];
        if (p && q) e += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) / scale / dt;
        const a = cur.shape[h], b = ref.shape[h];
        if (a && b) e += 0.4 * shapeDelta(a, b) / dt;
        // кол пайда болду / жоголду — бул да кыймыл
        if (!!a !== !!b) e += 1.0;
      }
      this.energy += (e - this.energy) * 0.5;
    }
    hist.push(cur);
    return { energy: this.energy, scale };
  }
}

const TIPS = [4, 8, 12, 16, 20];

interface MotionSample {
  t: number;
  wrist: (Vec3 | null)[];
  shape: (Float64Array | null)[];
}

/** Манжа учтарынын билекке салыштырмалуу абалы (алакандын өлчөмүндө). */
function tipShape(h: Vec3[]): Float64Array {
  const palm = Math.hypot(h[9][0] - h[0][0], h[9][1] - h[0][1], h[9][2] - h[0][2]) || 0.08;
  const out = new Float64Array(15);
  for (let k = 0; k < 5; k++) {
    const p = h[TIPS[k]];
    for (let d = 0; d < 3; d++) out[k * 3 + d] = (p[d] - h[0][d]) / palm;
  }
  return out;
}

function shapeDelta(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let k = 0; k < 5; k++) s += Math.hypot(a[k * 3] - b[k * 3], a[k * 3 + 1] - b[k * 3 + 1], a[k * 3 + 2] - b[k * 3 + 2]);
  return s / 5;
}

/** Кадрлардан клип жасайт: t 0дөн башталат, fps бааланат. */
export function toClip(frames: MocapFrame[]): MocapClip {
  if (!frames.length) return { kind: "mocap", fps: 30, frames: [] };
  const t0 = frames[0].t;
  const out = frames.map((f) => ({ ...f, t: f.t - t0 }));
  const dur = out[out.length - 1].t;
  const fps = out.length > 1 && dur > 0 ? Math.round(((out.length - 1) * 1000) / dur * 10) / 10 : 30;
  return { kind: "mocap", fps, frames: out };
}

/** Жөнөкөй клип жаздыргыч: start() → push(frame)… → stop(): MocapClip */
export class ClipRecorder {
  private frames: MocapFrame[] = [];
  private on = false;

  get recording(): boolean {
    return this.on;
  }

  get length(): number {
    return this.frames.length;
  }

  /** Жаздырылган узундук, мс */
  get duration(): number {
    const f = this.frames;
    return f.length > 1 ? f[f.length - 1].t - f[0].t : 0;
  }

  start(): void {
    this.frames = [];
    this.on = true;
  }

  push(frame: MocapFrame): void {
    if (!this.on) return;
    const last = this.frames[this.frames.length - 1];
    if (last && frame.t <= last.t) return; // кайталанган/артка кеткен убакыт
    this.frames.push(frame);
  }

  stop(opts: { trim?: boolean } = {}): MocapClip {
    this.on = false;
    let f = this.frames;
    this.frames = [];
    if (opts.trim ?? true) {
      // Башындагы жана аягындагы колу жок кадрларды кесүү
      let s = 0, e = f.length - 1;
      while (s < e && !f[s].leftHand && !f[s].rightHand) s++;
      while (e > s && !f[e].leftHand && !f[e].rightHand) e--;
      f = f.slice(s, e + 1);
    }
    return toClip(f);
  }
}
