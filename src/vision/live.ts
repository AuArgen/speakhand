// Түз эфирдеги таануу: кадр агымы → сегментатор → классификатор, алдын ала болжолдоо менен.
//
// React'сыз класс — CameraView'дун onFrame'ине, dev барагына жана replay тесттерине бирдей кызмат
// кылат. Бир кадр push() кылынат:
//   • сегментатор жестти бөлөт (кол түшкөндө же кыймыл stillMs токтогондо дароо бүтөт);
//   • жест жүрүп жатканда ар provisionalMs сайын учурдагы бөлүгү классификацияланат → onProvisional
//     (болжолдуу жооп; экранда "…" менен көрсөтүлөт);
//   • сегмент бүткөндө толук классификация → onSegment (final).
// Классификатор кийин келиши мүмкүн (жүктөлүп жатканда) — ага чейин сегменттер r = null менен берилет.

import type { MocapClip, MocapFrame, Recognition } from "../lib/types";
import type { SignClassifier } from "./classifier";
import { UtteranceDecoder, type DecoderOptions, type PhraseTemplate, type UtteranceResult } from "./decoder";
import { SignSegmenter, toClip, type FrameAux, type SegmenterOptions } from "./segmenter";

export interface LiveSegmentInfo {
  /** сегменттин башталышы жана аягы (кадр убактысы, мс) */
  startT: number;
  endT: number;
  /** сегмент бүттү деп табылган кадрдын убактысы (кечигүү = emitT − endT) */
  emitT: number;
  /** классификацияга кеткен убакыт, мс */
  classifyMs: number;
  /** сегмент күзгүлөнүп таанылдыбы (сол колдуу) */
  mirrored: boolean;
}

export interface LiveOptions {
  /**
   * "utterance" (демейки): сүйлөм — кол көтөрүлгөндөн ЭКИ кол тең түшкөнгө чейин; ичиндеги
   * токтоолор бөлбөйт; аягында декодер глосстордун ырааттуулугун табат (onUtterance).
   * "sign": ар бир жест өзүнчө — кыймыл токтогондо же кол түшкөндө дароо (onSegment).
   */
  mode?: "utterance" | "sign";
  segmenter?: SegmenterOptions;
  decoder?: DecoderOptions;
  /** Даяр сүйлөмдөр (декодердин тез жолу жана тил модели) */
  phrases?: PhraseTemplate[];
  /** Жест жүрүп жатканда болжолдуу жоопту ушунча мс сайын жаңыртуу (0 — өчүк, демейки 150) */
  provisionalMs?: number;
  /** Болжолдоо үчүн сегменттин эң кыска узундугу, мс (демейки 350) */
  minProvisionalMs?: number;
}

export interface LiveEvents {
  /** "sign" режими: бир жест бүттү */
  onSegment?: (clip: MocapClip, r: Recognition | null, info: LiveSegmentInfo) => void;
  /** "utterance" режими: колдор түштү — сүйлөм декоддолду (классификатор жок болсо result = null) */
  onUtterance?: (clip: MocapClip, result: UtteranceResult | null, info: LiveSegmentInfo) => void;
  /** "sign" режими: жест жүрүп жатканда болжолдуу жооп */
  onProvisional?: (r: Recognition | null) => void;
  /** "utterance" режими: учурдагы жарым-жартылай гипотеза (глосстор) */
  onHypothesis?: (gloss: string[]) => void;
  onSigning?: (active: boolean) => void;
}

/**
 * Сүйлөм режиминин сегментатор параметрлери: эки кол 500 мс түшсө — бүттү (негизги жол); столго
 * коюп эс алган адам үчүн колдор 1.2 с кыймылсыз турса да бүтөт (көп кыймылдуу сөздөрдүн ички
 * токтоолору андан алда канча кыска). Ичиндеги кыска токтоолор бөлбөйт.
 */
export const UTTERANCE_SEGMENTER: SegmenterOptions = { endOnStill: true, stillMs: 1200, restMs: 500, minMs: 300, maxMs: 12000 };

export class LiveRecognizer {
  readonly segmenter: SignSegmenter;
  readonly mode: "utterance" | "sign";
  private decoder: UtteranceDecoder | null = null;
  private decoderOpts: DecoderOptions | undefined;
  private phrases: PhraseTemplate[];
  private _classifier: SignClassifier | null;
  private ev: LiveEvents;
  private lastHypothesis = "";
  private provisionalMs: number;
  private minProvisionalMs: number;
  private lastProvisionalT = -Infinity;
  private wasActive = false;
  private provisional: Recognition | null = null;

  constructor(classifier: SignClassifier | null, events: LiveEvents = {}, opts: LiveOptions = {}) {
    this._classifier = classifier;
    this.ev = events;
    this.mode = opts.mode ?? "utterance";
    this.segmenter = new SignSegmenter(this.mode === "utterance" ? { ...UTTERANCE_SEGMENTER, ...opts.segmenter } : opts.segmenter);
    this.provisionalMs = opts.provisionalMs ?? (this.mode === "utterance" ? 300 : 150);
    this.minProvisionalMs = opts.minProvisionalMs ?? 350;
    this.decoderOpts = opts.decoder;
    this.phrases = opts.phrases ?? [];
  }

  get classifier(): SignClassifier | null {
    return this._classifier;
  }

  /** Классификатор кийин келгенде (жүктөлгөндө) коюлат; декодер кайра түзүлөт */
  set classifier(c: SignClassifier | null) {
    if (c === this._classifier) return;
    this._classifier = c;
    this.decoder = null;
  }

  setPhrases(phrases: PhraseTemplate[]): void {
    this.phrases = phrases;
    this.decoder?.setPhrases(phrases);
  }

  get signing(): boolean {
    return this.segmenter.active;
  }

  /** Акыркы болжолдуу жооп (жест жүрүп жатканда) */
  get guess(): Recognition | null {
    return this.provisional;
  }

  setEvents(events: LiveEvents): void {
    this.ev = events;
  }

  reset(): void {
    this.segmenter.reset();
    this.decoder?.reset();
    this.wasActive = false;
    this.provisional = null;
    this.lastHypothesis = "";
    this.lastProvisionalT = -Infinity;
  }

  private getDecoder(): UtteranceDecoder | null {
    if (!this._classifier) return null;
    if (!this.decoder) this.decoder = new UtteranceDecoder(this._classifier, this.phrases, this.decoderOpts);
    return this.decoder;
  }

  /** Бир кадр. Сегмент бүтсө — onSegment чакырылат жана таануу кайтарылат. */
  push(frame: MocapFrame, aux?: FrameAux): Recognition | null {
    const wasActive = this.segmenter.active;
    const seg = this.segmenter.push(frame, aux);
    const active = this.segmenter.active;
    if (this.mode === "utterance") {
      const dec = this.getDecoder();
      if (dec) {
        if (active && !wasActive) {
          // жаңы сүйлөм башталды: сегментатордун буферинде (preRoll менен) бар кадрларды беребиз
          dec.reset();
          for (const f of this.segmenter.peek()) dec.push(f);
        } else if (active || seg) dec.push(frame, this.segmenter.activity.raised);
      }
    }
    if (active !== this.wasActive) {
      this.wasActive = active;
      this.ev.onSigning?.(active);
      if (!active && !seg) this.clearProvisional();
    }
    if (seg) return this.finish(seg, frame.t);
    if (this.mode === "utterance") {
      if (active && this.provisionalMs > 0 && frame.t - this.lastProvisionalT >= this.provisionalMs) {
        this.lastProvisionalT = frame.t;
        const dec = this.getDecoder();
        if (dec) {
          const h = dec.hypothesis();
          const key = h.join(" ");
          if (key !== this.lastHypothesis) {
            this.lastHypothesis = key;
            this.ev.onHypothesis?.(h);
          }
        }
      }
      return null;
    }
    if (active && this.provisionalMs > 0 && this.classifier && frame.t - this.lastProvisionalT >= this.provisionalMs) {
      const buf = this.segmenter.peek();
      if (buf.length > 3 && buf[buf.length - 1].t - buf[0].t >= this.minProvisionalMs) {
        this.lastProvisionalT = frame.t;
        const r = this.classifier.classify(toClip(buf));
        if (r) {
          this.provisional = r;
          this.ev.onProvisional?.(r);
        }
      }
    }
    return null;
  }

  /** Учурдагы сегментти мажбурлап бүтүрөт (камера өчкөндө). */
  flush(now?: number): Recognition | null {
    const seg = this.segmenter.flush();
    this.wasActive = false;
    if (!seg) { this.clearProvisional(); return null; }
    return this.finish(seg, now ?? seg.frames[seg.frames.length - 1].t);
  }

  private clearProvisional() {
    if (this.provisional) {
      this.provisional = null;
      this.ev.onProvisional?.(null);
    }
    if (this.lastHypothesis) {
      this.lastHypothesis = "";
      this.ev.onHypothesis?.([]);
    }
  }

  private finish(seg: MocapClip, emitT: number): Recognition | null {
    const t0 = performance.now();
    const startT = this.segmenter.lastSegmentStart;
    const endT = startT + seg.frames[seg.frames.length - 1].t;
    if (this.mode === "utterance") {
      const dec = this.getDecoder();
      const result = dec ? dec.finish(endT) : null;
      const classifyMs = performance.now() - t0;
      this.lastHypothesis = "";
      this.ev.onHypothesis?.([]);
      this.ev.onUtterance?.(seg, result, { startT, endT, emitT, classifyMs, mirrored: false });
      if (!result?.gloss.length) return null;
      return { gloss: result.gloss.join(" "), confidence: result.confidence, alternatives: [] };
    }
    let r: Recognition | null = null;
    let mirrored = false;
    if (this.classifier) {
      const d = this.classifier.classifyDetailed(seg);
      if (d) {
        mirrored = d.mirrored;
        r = {
          gloss: d.ranked[0].gloss,
          confidence: d.ranked[0].confidence,
          alternatives: d.ranked.slice(1, 5).map((c) => ({ gloss: c.gloss, confidence: c.confidence })),
        };
      }
    }
    const classifyMs = performance.now() - t0;
    this.provisional = null;
    this.ev.onProvisional?.(null);
    this.ev.onSegment?.(seg, r, { startT, endT, emitT, classifyMs, mirrored });
    return r;
  }
}
