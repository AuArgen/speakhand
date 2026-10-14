// Китепкана клиптеринин кысылган форматы (format 2) → MocapClip.
//
// Файл: { v: 2, fps, n, q, fk, pose, lh, rh, face }. Ар бир агым (stream):
//   null — клипте такыр жок; же { m?: "1101…", d: number[] }
//   m — ар бир кадр үчүн "1" (бар) / "0" (жок); жок болсо — бардык кадрларда бар.
//   d — бар кадрлардын бүтүн сандары, кадр боюнча катар (pose 33×3, кол 21×3, бет fk.length),
//       убакыт боюнча дельта: биринчи бар кадр абсолюттук, калганы мурунку бар кадрдан айырма.
// Координаттар: бүтүн × q метр (q = 0.0005 → 0.5 мм). Бет: бүтүн / 100. Кадр убактысы: i × 1000 / fps.
// Коддоочу: tools/rsl_import/build.py (encode_clip).

import type { MocapClip, MocapFrame, Vec3 } from "../lib/types";

export interface EncodedStream {
  m?: string;
  d: number[];
}

export interface EncodedClip {
  v: 2;
  fps: number;
  n: number;
  /** метр бир бирдикке */
  q: number;
  /** бет blendshape аттары (face агымынын тартиби) */
  fk: string[];
  pose: EncodedStream | null;
  lh: EncodedStream | null;
  rh: EncodedStream | null;
  face: EncodedStream | null;
}

export function isEncodedClip(x: unknown): x is EncodedClip {
  return !!x && typeof x === "object" && (x as { v?: unknown }).v === 2 && Array.isArray((x as { fk?: unknown }).fk);
}

/** Агымды чечет: ар бир кадр үчүн бүтүн сандар массиви же null. */
function decodeStream(s: EncodedStream | null, n: number, width: number): (Int32Array | null)[] {
  const out: (Int32Array | null)[] = new Array(n).fill(null);
  if (!s) return out;
  const d = s.d;
  const acc = new Int32Array(width);
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (s.m && s.m.charCodeAt(i) !== 49 /* "1" */) continue;
    if (k + width > d.length) break; // бузулган файл — калганы жок деп эсептелет
    const row = new Int32Array(width);
    for (let j = 0; j < width; j++) {
      acc[j] += d[k + j];
      row[j] = acc[j];
    }
    k += width;
    out[i] = row;
  }
  return out;
}

function toPoints(row: Int32Array | null, count: number, q: number): Vec3[] | null {
  if (!row) return null;
  const pts: Vec3[] = new Array(count);
  // q = 0.0005 → (k × 5) / 10000: так ондук маани (4 белги), калкыма каталарсыз
  const scale = Math.round(q * 1e7);
  const exact = Math.abs(scale / 1e7 - q) < 1e-12;
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    pts[i] = exact
      ? [(row[o] * scale) / 1e7, (row[o + 1] * scale) / 1e7, (row[o + 2] * scale) / 1e7]
      : [row[o] * q, row[o + 1] * q, row[o + 2] * q];
  }
  return pts;
}

/** format 2 → MocapClip (кванттоо тактыгында так кайра калыбына келтирүү). */
export function decodeClip(json: EncodedClip): MocapClip {
  const { n, fps, q, fk } = json;
  const pose = decodeStream(json.pose, n, 33 * 3);
  const lh = decodeStream(json.lh, n, 21 * 3);
  const rh = decodeStream(json.rh, n, 21 * 3);
  const face = decodeStream(json.face, n, fk.length);
  const frames: MocapFrame[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let f: Record<string, number> | null = null;
    const fr = face[i];
    if (fr) {
      f = {};
      for (let j = 0; j < fk.length; j++) f[fk[j]] = fr[j] / 100;
    }
    frames[i] = {
      t: Math.round((i * 10000) / fps) / 10,
      pose: toPoints(pose[i], 33, q),
      leftHand: toPoints(lh[i], 21, q),
      rightHand: toPoints(rh[i], 21, q),
      face: f,
    };
  }
  return { kind: "mocap", fps, frames };
}
