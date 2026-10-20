// Жестти текшерүү API'си — src/lib/recognizer.ts'тен (үйрөнүү бөлүмү ушул жерден импорттойт).
export {
  checkSign,
  checkSequence,
  clearPersonalSamples,
  decodeUtterance,
  personalSampleCount,
  savePersonalSample,
  useSignCapture,
  type SignCheck,
  type UtteranceResult,
} from "../../lib/recognizer";
import type { SignCheck } from "../../lib/recognizer";

export type SequenceCheck = SignCheck & { matched: boolean[] };
