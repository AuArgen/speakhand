// Жалпы типтер — бардык модулдар (аватар, таануу, UI, сервер) ушул келишимге таянат.

/** [x, y, z] — метр. Координаттар системасы төмөндө. */
export type Vec3 = [number, number, number];

/**
 * Бир кадрдагы кыймыл-тартуу (motion capture) маалыматы.
 *
 * КООРДИНАТТАР (маанилүү!): баары three.js системасында, аватардын денесине карата:
 *   +x = адамдын СОЛ тарабы (камерага караган адамдын сол колу экранда оңдо),
 *   +y = өйдө, +z = камерага карай (адамдан алдыга).
 * MediaPipe world (x оңго, y ылдый, z камерадан алыс) → three: (x, -y, -z).
 * Пoза: MediaPipe poseWorldLandmarks (жамбаштын ортосу ≈ 0,0,0), 33 чекит.
 * Колдор: handWorldLandmarks (колдун борборуна салыштырмалуу), 21 чекит.
 * `left`/`right` — АДАМДЫН өзүнүн сол/оң колу (MediaPipe'дин күзгү белгиси эмес).
 */
export interface MocapFrame {
  /** Клиптин башынан бери, мс */
  t: number;
  pose: Vec3[] | null;
  leftHand: Vec3[] | null;
  rightHand: Vec3[] | null;
  /** Бет мимикасы: MediaPipe blendshape аты → 0..1 (тандалган бөлүгү гана) */
  face: Record<string, number> | null;
}

/** Жаздырылган же процедуралык жест клиби */
export interface MocapClip {
  kind: "mocap";
  fps: number;
  frames: MocapFrame[];
}

/** Фонологиялык (HamNoSys сыяктуу) сүрөттөлгөн жест — аватар IK менен ойнотот */
export interface KeyframeClip {
  kind: "keyframe";
  /** Жалпы узактыгы, мс */
  duration: number;
  keys: SignKey[];
}

export type HandShape =
  | "rest" | "flat" | "fist" | "point" | "v" | "thumb" | "y" | "o" | "c" | "five" | "l" | "pinch";

/** Денеге салыштырмалуу колдун абалы (метр, аватардын координаттарында) */
export interface HandTarget {
  /** Билектин (wrist) орду: аватардын жамбашына салыштырмалуу */
  pos: Vec3;
  shape: HandShape;
  /** Алакан кайда карайт: "fwd" | "back" | "in" (денеге) | "out" | "up" | "down" */
  palm: "fwd" | "back" | "in" | "out" | "up" | "down";
  /** Манжалар кайда багытталган */
  fingers?: "up" | "fwd" | "in" | "out" | "down";
}

export interface SignKey {
  /** 0..1 — клиптин ичиндеги убакыт */
  at: number;
  right?: HandTarget | "rest";
  left?: HandTarget | "rest";
  face?: Record<string, number>;
  head?: { nod?: number; shake?: number; tilt?: number };
}

export type SignClip = MocapClip | KeyframeClip;

/** Сөздүктөгү бир жест */
export interface SignEntry {
  /** Глосс — ЧОҢ ТАМГА менен кыргызча сөздүн уңгусу, мис. "САЛАМ" */
  gloss: string;
  /** Байланыштуу сөздөр/синонимдер (кичине тамга) — текстти глосско которууда колдонулат */
  aliases: string[];
  /**
   * Аватар ойното турган клип. Китепкана жесттеринде null — клип керек болгондо гана жүктөлөт
   * (`resolveClip(entry)`, src/data/library.ts; `clipUrl` боюнча).
   */
  clip: SignClip | null;
  /** Клиптин дареги (китепкана: "/signs/rsl/clips/<id>.json", format 2) */
  clipUrl?: string;
  /** Таануу үчүн мисалдар (жаздырылган клиптер) */
  samples: MocapClip[];
  /**
   * "demo" — болжолдуу, жест тилин билген адам текшериши керек;
   * "library" — видеосабактан тартылып алынган чыныгы жест (РЖЯ);
   * "recorded" — колдонуучу Студияда жаздырган
   */
  source: "demo" | "library" | "recorded";
  /** Китепканадагы жесттин келип чыгышы; ids — бардык варианттардын клип id'лери (биринчиси — clipUrl) */
  meta?: { ru?: string[]; lesson?: number; topic?: string; ids?: string[] };
  createdAt: number;
}

/** Текст → глосс котормосунун натыйжасы */
export interface GlossResult {
  /** Жест тилинин тартибиндеги глосстор */
  gloss: string[];
  /** Сөздүктө жок сөздөр дактилология (тамгалап) менен көрсөтүлөт */
  fingerspell: string[];
  /** Бет/баш белгилери: суроо, тануу ж.б. */
  nonManual?: { question?: boolean; negation?: boolean };
  /** Котормо кайдан келди */
  /** phrasebook — даяр котормо; cache — мурун AI которгон; rules — эрежелер (AI'сыз); claude — жаңы AI котормо */
  engine: "phrasebook" | "cache" | "rules" | "claude";
  model?: string;
}

/** Таануунун натыйжасы */
export interface Recognition {
  gloss: string;
  confidence: number;
  /** Башка талапкерлер */
  alternatives: { gloss: string; confidence: number }[];
}
