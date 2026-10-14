// Демо жесттер (KeyframeClip). ЭСКЕРТҮҮ: булар болжолдуу иллюстрациялар — орус жест тилинин (РЖЯ)
// жана эл аралык белгилүү формаларынын негизинде түзүлгөн. Кыргыз жест тилин билген адам
// текшериши жана студияда чыныгы жазуу менен алмаштырышы керек (source: "demo").
//
// Координаттар: билектин орду жамбашка салыштырмалуу (метр, аватар мейкиндиги),
// +x = аватардын СОЛ жагы → оң колдун x мааниси терс. Ийин ≈ (±0.185, 0.455), ээк ≈ (0, 0.58, 0.1),
// ооз ≈ (0, 0.635, 0.1), жаак ≈ (±0.07, 0.6, 0.085), маңдай ≈ (0, 0.76, 0.09), көкүрөк ≈ (0, 0.34, 0.12).
import type { HandShape, HandTarget, KeyframeClip, SignEntry, SignKey, Vec3 } from "../lib/types";
import type { ExtFingers, ExtHandTarget } from "./retarget";

type Palm = HandTarget["palm"];

/**
 * Кол абалы. `fingers` жалпы типтен тышкары ички багыттарды да кабыл алат ("chest" — өз көкүрөгүн
 * көрсөтүү, "back" — артка); алар src/avatar ичинде гана чечмеленет, сырткы келишим өзгөрбөйт.
 */
const H = (pos: Vec3, shape: HandShape, palm: Palm, fingers?: ExtFingers): HandTarget => {
  const t: ExtHandTarget = fingers ? { pos, shape, palm, fingers } : { pos, shape, palm };
  return t as unknown as HandTarget;
};

/** Сол колдун күзгү көчүрмөсү (x → −x) */
const M = (h: HandTarget): HandTarget => ({ ...h, pos: [-h.pos[0], h.pos[1], h.pos[2]] });

const clip = (duration: number, keys: SignKey[]): KeyframeClip => ({ kind: "keyframe", duration, keys });

const entry = (gloss: string, aliases: string[], c: KeyframeClip): SignEntry => ({
  gloss,
  aliases,
  clip: c,
  samples: [],
  source: "demo",
  createdAt: 0,
});

const smile = (v: number) => ({ mouthSmileLeft: v, mouthSmileRight: v });
const browsDown = (v: number) => ({ browDownLeft: v, browDownRight: v });
const browsUp = (v: number) => ({ browInnerUp: v, browOuterUpLeft: v, browOuterUpRight: v });

export const DEMO_SIGNS: SignEntry[] = [
  // САЛАМ — ачык алакан менен баштын жанында кол булгалоо
  entry(
    "САЛАМ",
    ["салам", "саламатсызбы", "ассалому алейкум", "салам алейкум", "саламатчылык"],
    clip(1400, [
      { at: 0, right: H([-0.24, 0.48, 0.16], "flat", "fwd", "up"), face: { ...smile(0.6), ...browsUp(0.35) }, head: { tilt: 0.15 } },
      { at: 0.22, right: H([-0.26, 0.56, 0.17], "five", "fwd", "up") },
      { at: 0.42, right: H([-0.2, 0.57, 0.18], "five", "fwd", "up") },
      { at: 0.62, right: H([-0.29, 0.56, 0.17], "five", "fwd", "up"), head: { tilt: 0.2 } },
      { at: 0.82, right: H([-0.21, 0.57, 0.18], "five", "fwd", "up") },
      { at: 1, right: H([-0.26, 0.56, 0.17], "five", "fwd", "up"), face: { ...smile(0.7), ...browsUp(0.2) }, head: { tilt: 0.1 } },
    ]),
  ),
  // РАХМАТ — алакан ээкке тийип, алдыга-ылдый жылат (алакан өйдө), баш ийкөө
  entry(
    "РАХМАТ",
    ["рахмат", "ыракмат", "чоң рахмат", "рахмат сизге", "ыракмат сага"],
    clip(1300, [
      { at: 0, right: H([-0.04, 0.38, 0.18], "flat", "back", "up"), face: smile(0.4), head: { nod: 0 } },
      { at: 0.2, right: H([-0.035, 0.385, 0.17], "flat", "back", "up") },
      { at: 0.65, right: H([-0.13, 0.3, 0.36], "flat", "up", "fwd"), head: { nod: 0.45 }, face: smile(0.7) },
      { at: 1, right: H([-0.14, 0.28, 0.38], "flat", "up", "fwd"), head: { nod: 0.15 } },
    ]),
  ),
  // ООБА — муштум билектен ийкелет (баш менен бирге)
  entry(
    "ООБА",
    ["ооба", "ия", "макул", "туура"],
    clip(1200, [
      { at: 0, right: H([-0.17, 0.36, 0.24], "fist", "fwd", "up"), head: { nod: 0 }, face: { ...smile(0.3), browInnerUp: 0.2 } },
      { at: 0.25, right: H([-0.17, 0.33, 0.26], "fist", "down", "fwd"), head: { nod: 0.5 } },
      { at: 0.5, right: H([-0.17, 0.36, 0.24], "fist", "fwd", "up"), head: { nod: -0.05 } },
      { at: 0.75, right: H([-0.17, 0.33, 0.26], "fist", "down", "fwd"), head: { nod: 0.5 } },
      { at: 1, right: H([-0.17, 0.36, 0.24], "fist", "fwd", "up"), head: { nod: 0 } },
    ]),
  ),
  // ЖОК — сөөмөй солго-оңго чайкалат, баш чайкоо, каш түйүлөт
  entry(
    "ЖОК",
    ["жок", "эмес", "жок дегенде"],
    clip(1300, [
      { at: 0, right: H([-0.16, 0.44, 0.24], "point", "fwd", "up"), head: { shake: 0 }, face: browsDown(0.45) },
      { at: 0.2, right: H([-0.11, 0.45, 0.24], "point", "fwd", "up"), head: { shake: 0.45 } },
      { at: 0.4, right: H([-0.21, 0.45, 0.24], "point", "fwd", "up"), head: { shake: -0.45 } },
      { at: 0.6, right: H([-0.11, 0.45, 0.24], "point", "fwd", "up"), head: { shake: 0.4 } },
      { at: 0.8, right: H([-0.21, 0.45, 0.24], "point", "fwd", "up"), head: { shake: -0.35 } },
      { at: 1, right: H([-0.16, 0.44, 0.24], "point", "fwd", "up"), head: { shake: 0 }, face: browsDown(0.3) },
    ]),
  ),
  // МЕН — сөөмөй өз көкүрөгүн көрсөтөт (эки жолу тийүү); манжа "chest" = төшкө карай
  entry(
    "МЕН",
    ["мен", "мага", "мени", "менин", "менде", "менден"],
    clip(1000, [
      { at: 0, right: H([-0.16, 0.31, 0.25], "point", "down", "chest") },
      { at: 0.35, right: H([-0.135, 0.33, 0.175], "point", "down", "chest"), head: { nod: 0.08 } },
      { at: 0.6, right: H([-0.15, 0.33, 0.22], "point", "down", "chest"), head: { nod: 0 } },
      { at: 0.85, right: H([-0.135, 0.33, 0.175], "point", "down", "chest"), head: { nod: 0.08 } },
      { at: 1, right: H([-0.135, 0.33, 0.18], "point", "down", "chest") },
    ]),
  ),
  // СЕН — сөөмөй менен маектешти көрсөтүү (алдыга түртүү)
  entry(
    "СЕН",
    ["сен", "сага", "сени", "сенин", "сиз", "сизге", "сизди", "сиздин"],
    clip(1000, [
      { at: 0, right: H([-0.13, 0.32, 0.22], "point", "down", "fwd"), face: { browInnerUp: 0.25 } },
      { at: 0.4, right: H([-0.11, 0.36, 0.38], "point", "down", "fwd"), head: { nod: 0.12 } },
      { at: 0.65, right: H([-0.12, 0.35, 0.32], "point", "down", "fwd") },
      { at: 1, right: H([-0.11, 0.36, 0.39], "point", "down", "fwd"), head: { nod: 0.05 } },
    ]),
  ),
  // ЖАКШЫ — баш бармак өйдө, алдыга эки жолу түртүү, жылмаюу
  entry(
    "ЖАКШЫ",
    ["жакшы", "жакшылап", "мыкты", "абдан жакшы", "сонун"],
    clip(1100, [
      { at: 0, right: H([-0.15, 0.33, 0.24], "thumb", "in", "fwd"), face: { ...smile(0.5), browInnerUp: 0.25 } },
      { at: 0.4, right: H([-0.14, 0.38, 0.33], "thumb", "in", "fwd"), head: { nod: 0.25 }, face: smile(0.85) },
      { at: 0.65, right: H([-0.145, 0.36, 0.3], "thumb", "in", "fwd"), head: { nod: 0 } },
      { at: 1, right: H([-0.14, 0.39, 0.35], "thumb", "in", "fwd"), head: { nod: 0.2 }, face: smile(0.85) },
    ]),
  ),
  // ЖАМАН — баш бармак ылдый, ылдый түртүү, ачуу мимика
  entry(
    "ЖАМАН",
    ["жаман", "начар", "жаман эмес"],
    clip(1100, [
      { at: 0, right: H([-0.15, 0.4, 0.26], "thumb", "out", "fwd"), face: { ...browsDown(0.4), mouthFrownLeft: 0.4, mouthFrownRight: 0.4 } },
      { at: 0.55, right: H([-0.15, 0.24, 0.31], "thumb", "out", "fwd"), head: { shake: 0.15, nod: 0.1 }, face: { ...browsDown(0.75), mouthFrownLeft: 0.8, mouthFrownRight: 0.8, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 } },
      { at: 0.8, right: H([-0.15, 0.27, 0.3], "thumb", "out", "fwd"), head: { shake: -0.15 } },
      { at: 1, right: H([-0.15, 0.24, 0.31], "thumb", "out", "fwd"), head: { shake: 0 } },
    ]),
  ),
  // СУУ — стаканды (C колу) оозго алып барып ичүү
  entry(
    "СУУ",
    ["суу", "сууну", "сууга", "суусун", "суусап", "ичүү"],
    clip(1400, [
      { at: 0, right: H([-0.11, 0.3, 0.27], "c", "in", "fwd") },
      { at: 0.4, right: H([-0.09, 0.46, 0.25], "c", "in", "fwd"), face: { jawOpen: 0.1 } },
      { at: 0.72, right: H([-0.09, 0.47, 0.25], "c", "in", "up"), head: { nod: -0.2 }, face: { mouthFunnel: 0.45, jawOpen: 0.15 } },
      { at: 1, right: H([-0.09, 0.465, 0.255], "c", "in", "up"), head: { nod: -0.1 }, face: { mouthFunnel: 0.2, jawOpen: 0.05 } },
    ]),
  ),
  // ТАМАК — бириккен манжалар оозго эки жолу тийет
  entry(
    "ТАМАК",
    ["тамак", "тамак жеш", "жеш", "жейм", "жегиле", "тамактан", "тамакка"],
    clip(1200, [
      { at: 0, right: H([-0.16, 0.56, 0.22], "o", "back", "in"), face: { jawOpen: 0 } },
      { at: 0.3, right: H([-0.135, 0.59, 0.185], "o", "back", "in"), face: { jawOpen: 0.35 } },
      { at: 0.55, right: H([-0.16, 0.58, 0.21], "o", "back", "in"), face: { jawOpen: 0.05 } },
      { at: 0.8, right: H([-0.135, 0.59, 0.185], "o", "back", "in"), face: { jawOpen: 0.35 } },
      { at: 1, right: H([-0.15, 0.585, 0.2], "o", "back", "in"), face: { jawOpen: 0.05 } },
    ]),
  ),
  // КЕЛ — алакан менен өзүнө чакыруу (эки жолу)
  entry(
    "КЕЛ",
    ["кел", "келиңиз", "келгиле", "келем", "келди", "келет", "келүү"],
    clip(1300, [
      { at: 0, right: H([-0.16, 0.3, 0.42], "flat", "up", "fwd"), face: { browInnerUp: 0.35, ...smile(0.3) } },
      { at: 0.4, right: H([-0.14, 0.35, 0.24], "flat", "back", "up"), head: { nod: 0.15 } },
      { at: 0.62, right: H([-0.16, 0.3, 0.39], "flat", "up", "fwd"), head: { nod: 0 } },
      { at: 1, right: H([-0.14, 0.35, 0.23], "flat", "back", "up"), head: { nod: 0.12 } },
    ]),
  ),
  // БАР (баруу) — эки сөөмөй жаа менен алдыга кетет
  entry(
    "БАР",
    ["бар", "барам", "барат", "барды", "баруу", "баргыла", "кет", "кеттик"],
    clip(1000, [
      { at: 0, right: H([-0.14, 0.34, 0.2], "point", "in", "up"), left: M(H([-0.14, 0.32, 0.18], "point", "in", "up")) },
      { at: 0.15, right: H([-0.14, 0.35, 0.21], "point", "in", "up"), left: M(H([-0.14, 0.33, 0.19], "point", "in", "up")) },
      { at: 0.8, right: H([-0.17, 0.33, 0.44], "point", "in", "fwd"), left: M(H([-0.17, 0.31, 0.42], "point", "in", "fwd")), head: { nod: 0.1 } },
      { at: 1, right: H([-0.17, 0.33, 0.45], "point", "in", "fwd"), left: M(H([-0.17, 0.31, 0.43], "point", "in", "fwd")) },
    ]),
  ),
  // ҮЙ — эки алакан чатыр, анан дубалдар
  entry(
    "ҮЙ",
    ["үй", "үйгө", "үйдө", "үйүм", "үйдөн", "үйүбүз"],
    clip(1300, [
      { at: 0, right: H([-0.135, 0.38, 0.27], "flat", "in"), left: M(H([-0.135, 0.38, 0.27], "flat", "in")) },
      { at: 0.3, right: H([-0.13, 0.39, 0.27], "flat", "in"), left: M(H([-0.13, 0.39, 0.27], "flat", "in")) },
      { at: 0.65, right: H([-0.16, 0.33, 0.27], "flat", "in", "up"), left: M(H([-0.16, 0.33, 0.27], "flat", "in", "up")) },
      { at: 1, right: H([-0.165, 0.26, 0.27], "flat", "in", "up"), left: M(H([-0.165, 0.26, 0.27], "flat", "in", "up")) },
    ]),
  ),
  // ДОС — сөөмөйлөр илмектешип, бирге чайкалат
  entry(
    "ДОС",
    ["дос", "достор", "досум", "досу", "курбу", "достук"],
    clip(1400, [
      { at: 0, right: H([-0.19, 0.34, 0.26], "point", "down", "in"), left: H([0.19, 0.3, 0.26], "point", "up", "in"), face: smile(0.4) },
      { at: 0.35, right: H([-0.085, 0.345, 0.27], "point", "down", "in"), left: H([0.085, 0.31, 0.27], "point", "up", "in") },
      { at: 0.6, right: H([-0.085, 0.375, 0.28], "point", "down", "in"), left: H([0.085, 0.34, 0.28], "point", "up", "in"), face: smile(0.7), head: { tilt: 0.15 } },
      { at: 0.82, right: H([-0.085, 0.335, 0.27], "point", "down", "in"), left: H([0.085, 0.3, 0.27], "point", "up", "in") },
      { at: 1, right: H([-0.085, 0.35, 0.27], "point", "down", "in"), left: H([0.085, 0.315, 0.27], "point", "up", "in"), head: { tilt: 0.05 } },
    ]),
  ),
  // ЖАРДАМ — баш бармак муштум сол алаканда, экөө бирге өйдө
  entry(
    "ЖАРДАМ",
    ["жардам", "жардамдаш", "жардам бер", "жардам бериңиз", "жардамдашуу", "көмөк"],
    clip(1300, [
      { at: 0, right: H([-0.035, 0.27, 0.25], "thumb", "in", "fwd"), left: H([0.06, 0.2, 0.25], "flat", "up", "in"), face: { browInnerUp: 0.45 } },
      { at: 0.25, right: H([-0.03, 0.255, 0.25], "thumb", "in", "fwd"), left: H([0.06, 0.2, 0.25], "flat", "up", "in") },
      { at: 0.85, right: H([-0.03, 0.375, 0.29], "thumb", "in", "fwd"), left: H([0.06, 0.32, 0.29], "flat", "up", "in"), face: { browInnerUp: 0.55 } },
      { at: 1, right: H([-0.03, 0.38, 0.29], "thumb", "in", "fwd"), left: H([0.06, 0.325, 0.29], "flat", "up", "in") },
    ]),
  ),
  // СҮЙҮҮ — колдор көкүрөктө айкашып, өзүн кучактоо
  entry(
    "СҮЙҮҮ",
    ["сүйүү", "сүйөм", "сүйөт", "сүйүктүү", "жакшы көрөм"],
    clip(1500, [
      { at: 0, right: H([-0.15, 0.3, 0.3], "fist", "back"), left: H([0.15, 0.28, 0.28], "fist", "back") },
      { at: 0.45, right: H([0.075, 0.37, 0.22], "fist", "back"), left: H([-0.07, 0.35, 0.17], "fist", "back"), face: smile(0.6) },
      { at: 0.75, right: H([0.07, 0.38, 0.205], "fist", "back"), left: H([-0.065, 0.36, 0.16], "fist", "back"), head: { tilt: 0.3, nod: 0.1 }, face: { ...smile(0.85), eyeSquintLeft: 0.35, eyeSquintRight: 0.35 } },
      { at: 1, right: H([0.075, 0.37, 0.21], "fist", "back"), left: H([-0.07, 0.355, 0.165], "fist", "back"), head: { tilt: 0.25, nod: 0.05 } },
    ]),
  ),
  // КАНДАЙ — эки бүгүлгөн кол алдыга оонап, алакандар өйдө; суроо мимикасы (каш түйүлүп, баш алдыга)
  entry(
    "КАНДАЙ",
    ["кандай", "кандайсыз", "кандайсың", "кантип", "кандайча", "эмне болду"],
    clip(1400, [
      { at: 0, right: H([-0.2, 0.28, 0.27], "c", "down", "in"), left: M(H([-0.2, 0.28, 0.27], "c", "down", "in")), face: { ...browsDown(0.5), browInnerUp: 0.25 } },
      { at: 0.5, right: H([-0.12, 0.32, 0.31], "five", "up", "fwd"), left: M(H([-0.12, 0.32, 0.31], "five", "up", "fwd")), head: { nod: 0.15, tilt: 0.15 }, face: { ...browsDown(0.75), browInnerUp: 0.35, eyeSquintLeft: 0.25, eyeSquintRight: 0.25 } },
      { at: 0.75, right: H([-0.15, 0.33, 0.31], "five", "up", "fwd"), left: M(H([-0.15, 0.33, 0.31], "five", "up", "fwd")), head: { nod: 0.2, tilt: 0.2, shake: 0.1 } },
      { at: 1, right: H([-0.16, 0.33, 0.31], "five", "up", "fwd"), left: M(H([-0.16, 0.33, 0.31], "five", "up", "fwd")), head: { nod: 0.18, tilt: 0.15, shake: 0 } },
    ]),
  ),
  // ЭРТЕҢ — баш бармак жаакка тийип, кол жаа менен алдыга (РЖЯ "завтра" / эл аралык форма)
  entry(
    "ЭРТЕҢ",
    ["эртең", "эртеңки", "эртеңге", "эртең менен", "кийинки күнү"],
    clip(1200, [
      { at: 0, right: H([-0.1, 0.55, 0.17], "thumb", "in", "fwd"), face: browsUp(0.3) },
      { at: 0.28, right: H([-0.1, 0.555, 0.165], "thumb", "in", "fwd") },
      { at: 0.75, right: H([-0.14, 0.5, 0.34], "thumb", "in", "fwd"), head: { nod: 0.1 }, face: browsUp(0.15) },
      { at: 1, right: H([-0.14, 0.49, 0.35], "thumb", "in", "fwd"), head: { nod: 0.05 } },
    ]),
  ),
  // КЕЧЭЭ — баш бармак жаакка тийип, кол артка (ийинге карай) кетет (РЖЯ "вчера" / эл аралык форма)
  entry(
    "КЕЧЭЭ",
    ["кечээ", "кечээки", "кечээ күнү", "мурунку күнү", "өткөн күнү"],
    clip(1200, [
      { at: 0, right: H([-0.1, 0.55, 0.19], "thumb", "in", "up"), face: browsUp(0.2) },
      { at: 0.28, right: H([-0.095, 0.555, 0.17], "thumb", "in", "up") },
      { at: 0.78, right: H([-0.15, 0.57, 0.085], "thumb", "in", "up"), head: { tilt: -0.12, shake: -0.1 } },
      { at: 1, right: H([-0.155, 0.575, 0.075], "thumb", "in", "up"), head: { tilt: -0.1, shake: -0.1 } },
    ]),
  ),
  // БҮГҮН — эки алакан өйдө карап, ылдый эки жолу түшөт ("азыр/бүгүн")
  entry(
    "БҮГҮН",
    ["бүгүн", "бүгүнкү", "азыр", "ушул күнү", "бүгүнчө"],
    clip(1200, [
      { at: 0, right: H([-0.17, 0.31, 0.3], "flat", "up", "fwd"), left: M(H([-0.17, 0.31, 0.3], "flat", "up", "fwd")), face: { browInnerUp: 0.15 } },
      { at: 0.3, right: H([-0.175, 0.23, 0.31], "flat", "up", "fwd"), left: M(H([-0.175, 0.23, 0.31], "flat", "up", "fwd")), head: { nod: 0.15 } },
      { at: 0.52, right: H([-0.17, 0.29, 0.3], "flat", "up", "fwd"), left: M(H([-0.17, 0.29, 0.3], "flat", "up", "fwd")), head: { nod: 0.02 } },
      { at: 0.8, right: H([-0.175, 0.22, 0.31], "flat", "up", "fwd"), left: M(H([-0.175, 0.22, 0.31], "flat", "up", "fwd")), head: { nod: 0.15 } },
      { at: 1, right: H([-0.175, 0.235, 0.31], "flat", "up", "fwd"), left: M(H([-0.175, 0.235, 0.31], "flat", "up", "fwd")), head: { nod: 0.08 } },
    ]),
  ),
  // АТ (ат, менин атым) — эки "V/H" кол: оң колдун манжалары сол колдун манжаларына эки жолу тийет
  entry(
    "АТ",
    ["ат", "атым", "атың", "атыңыз", "аты", "ысым", "ысымы", "аталат"],
    clip(1300, [
      { at: 0, right: H([-0.09, 0.4, 0.29], "v", "down", "in"), left: H([0.08, 0.3, 0.28], "v", "in", "fwd"), face: { browInnerUp: 0.2 } },
      { at: 0.3, right: H([-0.08, 0.345, 0.3], "v", "down", "in"), left: H([0.08, 0.3, 0.28], "v", "in", "fwd"), head: { nod: 0.1 } },
      { at: 0.5, right: H([-0.085, 0.39, 0.3], "v", "down", "in"), left: H([0.08, 0.3, 0.28], "v", "in", "fwd"), head: { nod: 0 } },
      { at: 0.75, right: H([-0.08, 0.345, 0.3], "v", "down", "in"), left: H([0.08, 0.3, 0.28], "v", "in", "fwd"), head: { nod: 0.1 } },
      { at: 1, right: H([-0.08, 0.35, 0.3], "v", "down", "in"), left: H([0.08, 0.3, 0.28], "v", "in", "fwd"), head: { nod: 0.05 } },
    ]),
  ),
];
