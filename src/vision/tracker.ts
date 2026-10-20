// Камера → MediaPipe (колдор + поза + бет) → аватардын координаттарындагы MocapFrame.
//
// Координаттар (src/lib/types.ts): MediaPipe world (x оңго, y ылдый, z камерадан алыс)
// → three.js (x, -y, -z). Күзгүлөнбөгөн вебкамерада сүрөттүн оң жагы = адамдын сол тарабы,
// демек +x = адамдын СОЛ тарабы. Колдор адамдын анатомиялык колу боюнча бөлүштүрүлөт
// (handedness.ts), MediaPipe'дин күзгү белгисине гана ишенбейбиз.

import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type Category,
  type Landmark,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { MocapFrame, Vec3 } from "../lib/types";
import { assignHands, type Assignment } from "./handedness";

export interface TrackerOptions {
  /** Бет мимикасын (blendshapes) да эсептөө (демейки false) */
  face?: boolean;
  numHands?: 2;
  /** Поза модели: "lite" (тез, демейки) же "full" (тагыраак) */
  poseModel?: "lite" | "full";
  /** Бетти ар бир канча кадрда эсептөө (демейки 2 — ылдамдык үчүн) */
  faceEvery?: number;
  /** "GPU" (демейки, болбосо CPU'га өтөт) же "CPU" */
  delegate?: "GPU" | "CPU";
  /** Моделдер жана wasm жайгашкан базалык жол (демейки import.meta.env.BASE_URL) */
  baseUrl?: string;
  /**
   * Кирген сүрөт ушундан кең болсо, моделдерге берүүдөн мурун кичирейтилет (демейки 640).
   * Моделдер ичинде 224–256 px менен иштейт — чоң кадр тактыкка эч нерсе кошпойт, GPU'га жүктөөнү гана узартат.
   */
  maxWidth?: number;
}

/** detect() кабыл алган булактар */
export type DetectSource = HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | VideoFrame;

export interface ImagePoint { x: number; y: number; v?: number }

export interface TrackResult {
  /** аватардын координаттарында, t = timestamp ms */
  frame: MocapFrame;
  /** Нормалдаштырылган 0..1 сүрөт координаттары (күзгүлөнбөгөн), оверлей тартуу үчүн */
  image: {
    pose: ImagePoint[] | null;
    left: ImagePoint[] | null;
    right: ImagePoint[] | null;
    face: ImagePoint[] | null;
  };
  /** Колдор кантип бөлүштүрүлдү (диагностика) */
  handMethod?: { left?: Assignment["method"][number]; right?: Assignment["method"][number] };
  /** Моделдердин убактысы, мс (диагностика) */
  timing?: { pose: number; hand: number; face: number; total: number };
}

/** Аватарга берилүүчү бет blendshape'тери */
export const FACE_BLENDSHAPES = [
  "browInnerUp", "browDownLeft", "browDownRight", "browOuterUpLeft", "browOuterUpRight",
  "eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft", "eyeSquintRight", "jawOpen",
  "mouthSmileLeft", "mouthSmileRight", "mouthPucker", "mouthFunnel", "cheekPuff",
] as const;
const FACE_SET = new Set<string>(FACE_BLENDSHAPES);

/** Оверлей үчүн беттин сейрек чекиттери (контурлар, ар бир экинчиси) */
let faceSubset: number[] | null = null;
function faceIndices(): number[] {
  if (faceSubset) return faceSubset;
  const set = new Set<number>();
  for (const c of FaceLandmarker.FACE_LANDMARKS_CONTOURS) { set.add(c.start); set.add(c.end); }
  faceSubset = [...set].sort((a, b) => a - b).filter((_, i) => i % 2 === 0);
  return faceSubset;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** MediaPipe world → three.js аватар мейкиндиги */
function toAvatar(l: Landmark): Vec3 {
  return [r4(l.x), r4(-l.y), r4(-l.z)];
}
function toImage(l: NormalizedLandmark, withVis = false): ImagePoint {
  return withVis ? { x: l.x, y: l.y, v: l.visibility } : { x: l.x, y: l.y };
}

function baseUrl(opt?: string): string {
  let b = opt ?? ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/");
  if (!b.endsWith("/")) b += "/";
  return b;
}

async function withDelegate<T>(
  preferred: "GPU" | "CPU",
  make: (delegate: "GPU" | "CPU") => Promise<T>,
): Promise<{ task: T; delegate: "GPU" | "CPU" }> {
  if (preferred === "GPU") {
    try {
      return { task: await make("GPU"), delegate: "GPU" };
    } catch (e) {
      console.warn("[vision] GPU delegate иштеген жок, CPU колдонулат:", e);
    }
  }
  return { task: await make("CPU"), delegate: "CPU" };
}

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

export class Tracker {
  private hand: HandLandmarker;
  private pose: PoseLandmarker;
  private face: FaceLandmarker | null = null;
  private lastTs = -1;
  private lastVideoTime = -1;
  private frameNo = 0;
  private lastFace: { blend: Record<string, number> | null; pts: ImagePoint[] | null } = { blend: null, pts: null };
  private closed = false;
  /** кичирейтүү үчүн буфер */
  private scaled: OffscreenCanvas | HTMLCanvasElement | null = null;
  private scaledCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  /** акыркы detect()тин убактысы (диагностика) */
  lastTiming = { pose: 0, hand: 0, face: 0, total: 0 };
  /** Колдонулуп жаткан delegate'тер (диагностика) */
  readonly delegates: { hand: string; pose: string; face?: string };

  private constructor(
    private fileset: Fileset,
    private opts: Required<Omit<TrackerOptions, "baseUrl">> & { baseUrl: string },
    hand: { task: HandLandmarker; delegate: string },
    pose: { task: PoseLandmarker; delegate: string },
  ) {
    this.hand = hand.task;
    this.pose = pose.task;
    this.delegates = { hand: hand.delegate, pose: pose.delegate };
  }

  /** Моделдерди /models жана wasm'ды /mediapipe-wasm'дан жүктөйт. GPU, болбосо CPU. */
  static async create(opts: TrackerOptions = {}): Promise<Tracker> {
    const base = baseUrl(opts.baseUrl);
    const o = {
      face: opts.face ?? false,
      numHands: 2 as const,
      poseModel: opts.poseModel ?? "lite",
      faceEvery: Math.max(1, opts.faceEvery ?? 2),
      delegate: opts.delegate ?? "GPU",
      baseUrl: base,
      maxWidth: opts.maxWidth ?? 640,
    };
    const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe-wasm`);
    const [hand, pose] = await Promise.all([
      withDelegate(o.delegate, (delegate) =>
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        }),
      ),
      withDelegate(o.delegate, (delegate) =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/pose_landmarker_${o.poseModel}.task`, delegate },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        }),
      ),
    ]);
    const t = new Tracker(fileset, o, hand, pose);
    if (o.face) await t.setFace(true);
    return t;
  }

  /** Бет моделин күйгүзөт/өчүрөт (керек болгондо жүктөлөт). */
  async setFace(enabled: boolean): Promise<void> {
    this.opts.face = enabled;
    if (!enabled) {
      this.face?.close();
      this.face = null;
      this.lastFace = { blend: null, pts: null };
      delete this.delegates.face;
      return;
    }
    if (this.face) return;
    const { task, delegate } = await withDelegate(this.opts.delegate, (d) =>
      FaceLandmarker.createFromOptions(this.fileset, {
        baseOptions: { modelAssetPath: `${this.opts.baseUrl}models/face_landmarker.task`, delegate: d },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      }),
    );
    if (this.closed || !this.opts.face) { task.close(); return; }
    this.face = task;
    this.delegates.face = delegate;
  }

  /**
   * Видеонун (же канвастын / ImageBitmap'тин) учурдагы кадрын иштетет. Видео даяр эмес болсо же
   * жаңы кадр жок болсо — null (мурунку натыйжаны кайра колдонуңуз).
   */
  detect(source: DetectSource, timestampMs: number): TrackResult | null {
    if (this.closed) return null;
    let w: number, h: number;
    if (source instanceof HTMLVideoElement) {
      if (source.readyState < 2 || !source.videoWidth) return null;
      if (source.currentTime === this.lastVideoTime) return null;
      this.lastVideoTime = source.currentTime;
      w = source.videoWidth; h = source.videoHeight;
    } else if ("displayWidth" in source) {
      w = source.displayWidth; h = source.displayHeight;
    } else {
      w = source.width; h = source.height;
    }
    if (!w || !h) return null;
    // MediaPipe монотондуу өсүүчү убакытты талап кылат
    const ts = timestampMs > this.lastTs ? timestampMs : this.lastTs + 1;
    this.lastTs = ts;
    this.frameNo++;
    const t0 = performance.now();
    const input = this.downscale(source, w, h);

    const pr = this.pose.detectForVideo(input, ts);
    const t1 = performance.now();
    const hr = this.hand.detectForVideo(input, ts);
    const t2 = performance.now();
    if (this.face && this.frameNo % this.opts.faceEvery === 0) {
      const fr = this.face.detectForVideo(input, ts);
      const blend = fr.faceBlendshapes?.[0]?.categories;
      this.lastFace = {
        blend: blend ? pickBlend(blend) : null,
        pts: fr.faceLandmarks?.[0] ? faceIndices().map((i) => toImage(fr.faceLandmarks[0][i])) : null,
      };
    }
    const t3 = performance.now();
    this.lastTiming = { pose: t1 - t0, hand: t2 - t1, face: t3 - t2, total: t3 - t0 };
    const aspect = w / h;

    const poseImg = pr.landmarks?.[0] ?? null;
    const poseWorld = pr.worldLandmarks?.[0] ?? null;

    let leftHand: Vec3[] | null = null, rightHand: Vec3[] | null = null;
    let leftImg: ImagePoint[] | null = null, rightImg: ImagePoint[] | null = null;
    const handMethod: TrackResult["handMethod"] = {};
    const n = Math.min(hr.landmarks?.length ?? 0, hr.worldLandmarks?.length ?? 0);
    if (n) {
      const { sides, method } = assignHands({
        wrists: hr.landmarks.slice(0, n).map((l) => l[0]),
        labels: hr.landmarks.slice(0, n).map((_, i) => (hr.handedness ?? hr.handednesses)?.[i]?.[0]?.categoryName),
        pose: poseImg,
        aspect,
        mirroredInput: false,
      });
      for (let i = 0; i < n; i++) {
        const world = hr.worldLandmarks[i].map(toAvatar);
        const img = hr.landmarks[i].map((l) => toImage(l));
        if (sides[i] === "left" && !leftHand) { leftHand = world; leftImg = img; handMethod.left = method[i]; }
        else if (sides[i] === "right" && !rightHand) { rightHand = world; rightImg = img; handMethod.right = method[i]; }
      }
    }

    const frame: MocapFrame = {
      t: timestampMs,
      pose: poseWorld ? poseWorld.map(toAvatar) : null,
      leftHand,
      rightHand,
      face: this.face ? this.lastFace.blend : null,
    };
    return {
      frame,
      image: {
        pose: poseImg ? poseImg.map((l) => toImage(l, true)) : null,
        left: leftImg,
        right: rightImg,
        face: this.face ? this.lastFace.pts : null,
      },
      handMethod,
      timing: this.lastTiming,
    };
  }

  /** Кадр maxWidth'тен кең болсо — кичирейтилген көчүрмөсү (буферде), болбосо өзү. */
  private downscale(source: DetectSource, w: number, h: number): DetectSource {
    const max = this.opts.maxWidth;
    if (!(max > 0) || w <= max) return source;
    const sw = max, sh = Math.round((h * max) / w);
    if (!this.scaled) {
      this.scaled = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(sw, sh) : document.createElement("canvas");
      this.scaledCtx = (this.scaled as OffscreenCanvas).getContext("2d", { alpha: false, willReadFrequently: false }) as OffscreenCanvasRenderingContext2D | null;
    }
    const c = this.scaled, ctx = this.scaledCtx;
    if (!ctx) return source;
    if (c.width !== sw || c.height !== sh) { c.width = sw; c.height = sh; }
    (ctx as CanvasRenderingContext2D).drawImage(source as CanvasImageSource, 0, 0, sw, sh);
    return c;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hand.close();
    this.pose.close();
    this.face?.close();
    this.face = null;
  }
}

function pickBlend(cats: Category[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cats) if (FACE_SET.has(c.categoryName)) out[c.categoryName] = Math.round(c.score * 1000) / 1000;
  return out;
}

/** Алдыңкы камераны ачып, видео элементке туташтырат жана ойнотот. */
export async function startCamera(
  video: HTMLVideoElement,
  opts: { width?: number; height?: number; deviceId?: string } = {},
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Бул браузерде камерага кирүү мүмкүн эмес (getUserMedia жок / https эмес)");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: opts.width ?? 640 },
      height: { ideal: opts.height ?? 480 },
      frameRate: { ideal: 30 },
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : { facingMode: "user" }),
    },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve) => {
    if (video.readyState >= 1) resolve();
    else video.addEventListener("loadedmetadata", () => resolve(), { once: true });
  });
  await video.play();
  return stream;
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}
