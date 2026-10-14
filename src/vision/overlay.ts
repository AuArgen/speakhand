// Видеонун үстүнө скелет оверлейин тартуу.
// UI видеону күзгүлөп (selfie) көрсөтөт — mirrored: true болсо оверлей да ошондой чагылдырылат.

import type { TrackResult } from "./tracker";

export interface OverlayOptions {
  mirrored: boolean;
  width: number;
  height: number;
  /** Колдордун түсү (демейки бирюза) */
  accent?: string;
  /** Сол колдун түсү (демейки: accent берилсе ошол эле, болбосо кызгылт-көк) */
  accent2?: string;
  /** Тартуудан мурун канвасты тазалоо (демейки true) */
  clear?: boolean;
}

/** Колдун байланыштары (MediaPipe HAND_CONNECTIONS) */
const HAND_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** Дененин жогорку бөлүгү (бет жана буттар жок — колдорго көңүл) */
const POSE_EDGES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
];
const POSE_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24];
const FINGERTIPS = new Set([4, 8, 12, 16, 20]);

interface P { x: number; y: number; v?: number }

export function drawOverlay(ctx: CanvasRenderingContext2D, res: TrackResult | null, opts: OverlayOptions): void {
  const { width: W, height: H, mirrored } = opts;
  const accent = opts.accent ?? "#4fe3c1";
  // accent берилсе эки кол бирдей түстө; болбосо сол кол башка түстө (сол/оң текшерүү үчүн ыңгайлуу)
  const accent2 = opts.accent2 ?? (opts.accent ? accent : "#a99bff");
  if (opts.clear ?? true) ctx.clearRect(0, 0, W, H);
  if (!res) return;
  const X = (p: P) => (mirrored ? 1 - p.x : p.x) * W;
  const Y = (p: P) => p.y * H;
  const scale = Math.max(0.6, Math.min(W, H) / 480);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Бет — сейрек чекиттер
  const face = res.image.face;
  if (face) {
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    const r = 1.1 * scale;
    ctx.beginPath();
    for (const p of face) {
      ctx.moveTo(X(p) + r, Y(p));
      ctx.arc(X(p), Y(p), r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // Поза — назик ак сызыктар
  const pose = res.image.pose;
  if (pose && pose.length > 24) {
    const vis = (i: number) => (pose[i].v ?? 1) > 0.5;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2 * scale;
    ctx.shadowColor = "rgba(255,255,255,0.35)";
    ctx.shadowBlur = 6 * scale;
    ctx.beginPath();
    for (const [a, b] of POSE_EDGES) {
      if (!vis(a) || !vis(b)) continue;
      ctx.moveTo(X(pose[a]), Y(pose[a]));
      ctx.lineTo(X(pose[b]), Y(pose[b]));
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    for (const i of POSE_JOINTS) {
      if (!vis(i)) continue;
      const r = 2.6 * scale;
      ctx.moveTo(X(pose[i]) + r, Y(pose[i]));
      ctx.arc(X(pose[i]), Y(pose[i]), r, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // Колдор — жаркыраган accent сызыктар
  drawHand(ctx, res.image.right, accent, X, Y, scale);
  drawHand(ctx, res.image.left, accent2, X, Y, scale);
  ctx.restore();
}

function drawHand(
  ctx: CanvasRenderingContext2D, pts: P[] | null, color: string,
  X: (p: P) => number, Y: (p: P) => number, scale: number,
): void {
  if (!pts || pts.length < 21) return;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  // эки өтүү: кең жумшак жаркыроо + ичке ачык сызык
  for (const [w, blur, alpha] of [[4.5, 14, 0.35], [2, 4, 1]] as const) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = w * scale;
    ctx.shadowBlur = blur * scale;
    ctx.beginPath();
    for (const [a, b] of HAND_EDGES) {
      ctx.moveTo(X(pts[a]), Y(pts[a]));
      ctx.lineTo(X(pts[b]), Y(pts[b]));
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 6 * scale;
  for (let i = 0; i < 21; i++) {
    const r = (FINGERTIPS.has(i) ? 3 : 2) * scale;
    ctx.beginPath();
    ctx.arc(X(pts[i]), Y(pts[i]), r, 0, Math.PI * 2);
    ctx.fillStyle = FINGERTIPS.has(i) ? "#ffffff" : color;
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}
