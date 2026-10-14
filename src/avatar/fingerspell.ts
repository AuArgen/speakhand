// Дактилология (тамгалап көрсөтүү).
// ЭСКЕРТҮҮ: бул — болжолдуу жакындатуу! Кол формаларынын китепканасы чектелүү (12 форма), ошондуктан
// ар бир кыргыз тамгасы эң жакын формага (РЖЯ дактил алфавитине негизделип) туураланат.
// Чыныгы дактил алфавити студияда жест тилин билген адамдан жазылып алынышы керек.
import type { HandShape, HandTarget, KeyframeClip, SignKey } from "../lib/types";

interface Letter {
  shape: HandShape;
  palm?: HandTarget["palm"];
  fingers?: HandTarget["fingers"];
}

const L = (shape: HandShape, palm: HandTarget["palm"] = "fwd", fingers: HandTarget["fingers"] = "up"): Letter => ({ shape, palm, fingers });

/** Кыргыз кириллицасы → болжолдуу кол формасы */
const LETTERS: Record<string, Letter> = {
  А: L("fist"),
  Б: L("pinch", "in"),
  В: L("flat"),
  Г: L("l", "down", "fwd"),
  Д: L("v", "back"),
  Е: L("c", "in"),
  Ё: L("c", "in"),
  Ж: L("five", "down", "fwd"),
  З: L("point"),
  И: L("v", "fwd"),
  Й: L("v", "in"),
  К: L("v", "in"),
  Л: L("v", "back", "down"),
  М: L("flat", "back", "down"),
  Н: L("v", "in", "fwd"),
  Ң: L("v", "in", "fwd"),
  О: L("o", "in"),
  Ө: L("o", "fwd"),
  П: L("v", "back", "down"),
  Р: L("pinch", "fwd"),
  С: L("c", "in"),
  Т: L("flat", "down", "fwd"),
  У: L("y"),
  Ү: L("y", "in"),
  Ф: L("o", "fwd"),
  Х: L("c", "fwd"),
  Ц: L("point", "in"),
  Ч: L("pinch", "in"),
  Ш: L("five", "back", "down"),
  Щ: L("five", "back", "down"),
  Ъ: L("point", "back"),
  Ы: L("l", "fwd"),
  Ь: L("thumb", "in"),
  Э: L("c", "out"),
  Ю: L("o", "out"),
  Я: L("v", "fwd"),
};

const LETTER_MS = 350;
const LEAD_MS = 150;

export function fingerspellClip(word: string): KeyframeClip | null {
  const chars = [...word.toUpperCase()].filter((c) => c === " " || c === "-" || LETTERS[c]);
  while (chars.length && (chars[0] === " " || chars[0] === "-")) chars.shift();
  if (!chars.some((c) => LETTERS[c])) return null;
  const duration = LEAD_MS + chars.length * LETTER_MS + 100;
  const keys: SignKey[] = [];
  const base: [number, number, number] = [-0.17, 0.43, 0.26];
  let prev = "";
  let bounce = 0;
  chars.forEach((c, i) => {
    const t0 = LEAD_MS + i * LETTER_MS;
    if (c === " " || c === "-") {
      prev = "";
      return;
    }
    const l = LETTERS[c];
    // Кол бир аз сыртка жылат (окуу оңой болушу үчүн); кайталанган тамга — кичине секирик
    bounce = c === prev ? (bounce ? 0 : 1) : 0;
    const x = base[0] - 0.006 * i - 0.025 * bounce;
    const target: HandTarget = {
      pos: [x, base[1] + 0.008 * Math.sin(i * 1.7), base[2]],
      shape: l.shape,
      palm: l.palm ?? "fwd",
      ...(l.fingers ? { fingers: l.fingers } : {}),
    };
    // Келүү (35%) жана кармап туруу
    keys.push({ at: (t0 + LETTER_MS * 0.35) / duration, right: target });
    keys.push({ at: (t0 + LETTER_MS * 0.85) / duration, right: target });
    prev = c;
  });
  if (!keys.length) return null;
  keys.unshift({ at: 0, right: keys[0].right, face: { browInnerUp: 0.15 } });
  return { kind: "keyframe", duration, keys };
}
