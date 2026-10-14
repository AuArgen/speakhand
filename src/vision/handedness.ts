// Табылган колдорду адамдын анатомиялык сол/оң колуна бөлүштүрүү.
//
// MediaPipe'дин handedness белгиси сүрөт күзгүлөнгөн (selfie) деп эсептейт. Күзгүлөнбөгөн
// вебкамера агымында белги тескери болот. Ошондуктан негизги ыкма — pose'дун билектерине
// (сүрөттөгү 15 = адамдын сол билеги, 16 = оң билеги) эң жакындыгы; pose ишенимсиз болсо —
// туура которулган белгиге, андан кийин сүрөттөгү x абалына кайтабыз.

export type Side = "left" | "right";

export interface Pt2 { x: number; y: number; visibility?: number }

export interface AssignInput {
  /** Ар бир колдун сүрөттөгү билеги (hand landmark 0), нормалдаштырылган 0..1 */
  wrists: Pt2[];
  /** MediaPipe белгиси ("Left" | "Right"), белгисиз болсо undefined */
  labels: (string | undefined)[];
  /** Pose'дун сүрөттөгү чекиттери (33) же null */
  pose: Pt2[] | null;
  /** Сүрөттүн туурасы/бийиктиги (аралыкты туура эсептөө үчүн) */
  aspect?: number;
  /** Кирген сүрөт күзгүлөнгөнбү (демейки false — кадимки вебкамера) */
  mirroredInput?: boolean;
}

export interface Assignment {
  sides: Side[];
  /** Ар бир кол кантип бөлүштүрүлдү */
  method: ("wrist" | "label" | "position")[];
}

/** Ушундан алыс болсо, pose билеги бул колго тиешеси жок деп эсептелет (сүрөт бийиктигинин үлүшү) */
const MAX_WRIST_DIST = 0.25;
/** Эки вариант бири-биринен ушунчалык аз айырмаланса — ишенимсиз */
const AMBIGUOUS = 0.02;

function labelSide(label: string | undefined, mirroredInput: boolean): Side | null {
  if (label !== "Left" && label !== "Right") return null;
  const l: Side = label === "Left" ? "left" : "right";
  if (mirroredInput) return l;
  return l === "left" ? "right" : "left";
}

/** Күзгүлөнбөгөн сүрөттө адамдын сол колу сүрөттүн оң жагында (x чоңураак). */
function positionSide(x: number, mirroredInput: boolean): Side {
  return (x >= 0.5) !== mirroredInput ? "left" : "right";
}

export function assignHands(inp: AssignInput): Assignment {
  const { wrists, labels, pose } = inp;
  const aspect = inp.aspect ?? 4 / 3;
  const mirrored = inp.mirroredInput ?? false;
  const n = wrists.length;
  const sides: Side[] = new Array(n);
  const method: Assignment["method"] = new Array(n);
  if (!n) return { sides, method };

  const dist = (a: Pt2, b: Pt2) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
  const lw = pose && pose.length > 16 ? pose[15] : null;
  const rw = pose && pose.length > 16 ? pose[16] : null;
  const ok = (p: Pt2 | null) => !!p && (p.visibility ?? 1) >= 0.2;

  if (ok(lw) && ok(rw)) {
    const dL = wrists.map((w) => dist(w, lw!));
    const dR = wrists.map((w) => dist(w, rw!));
    if (n === 1) {
      const near = Math.min(dL[0], dR[0]);
      if (near < MAX_WRIST_DIST && Math.abs(dL[0] - dR[0]) > AMBIGUOUS) {
        sides[0] = dL[0] < dR[0] ? "left" : "right";
        method[0] = "wrist";
        return { sides, method };
      }
    } else {
      // эки кол (ашыкчасы эске алынбайт): эки вариантты салыштырабыз
      const a = dL[0] + dR[1]; // 0 → сол, 1 → оң
      const b = dR[0] + dL[1]; // 0 → оң, 1 → сол
      const worst = Math.min(Math.max(dL[0], dR[1]), Math.max(dR[0], dL[1]));
      if (Math.abs(a - b) > AMBIGUOUS && worst < MAX_WRIST_DIST * 1.5) {
        const first: Side = a < b ? "left" : "right";
        sides[0] = first;
        sides[1] = first === "left" ? "right" : "left";
        method[0] = method[1] = "wrist";
        for (let i = 2; i < n; i++) { sides[i] = dL[i] < dR[i] ? "left" : "right"; method[i] = "wrist"; }
        return { sides, method };
      }
    }
  }

  // Белги боюнча (күзгү эске алынып)
  for (let i = 0; i < n; i++) {
    const s = labelSide(labels[i], mirrored);
    sides[i] = s ?? positionSide(wrists[i].x, mirrored);
    method[i] = s ? "label" : "position";
  }
  // Эки кол бир тарапка түшүп калса — сүрөттөгү абалы боюнча бөлөбүз
  if (n >= 2 && sides[0] === sides[1]) {
    const leftIsFirst = (wrists[0].x > wrists[1].x) !== mirrored;
    sides[0] = leftIsFirst ? "left" : "right";
    sides[1] = leftIsFirst ? "right" : "left";
    method[0] = method[1] = "position";
  }
  return { sides, method };
}
