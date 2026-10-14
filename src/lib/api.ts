// Backend менен байланыш.
import type { GlossResult, SignEntry } from "./types";

export type ClaudeModel = "sonnet" | "haiku" | "opus";

export interface Health {
  ok: boolean;
  claude: string | null;
  models: ClaudeModel[];
  tts: boolean;
  /** Даяр котормо китепчесиндеги сүйлөмдөр саны */
  phrasebook: number;
  /** Мурун AI которуп, сакталган сүйлөмдөр саны */
  cached: number;
}

/** auto — алгач даяр/сакталган/эрежелер, AI акыркы жол; offline — AI'сыз; ai — дайыма AI (сакталгандан башкасы) */
export type GlossMode = "auto" | "offline" | "ai";

export async function getHealth(): Promise<Health | null> {
  try {
    const r = await fetch("/api/health", { signal: AbortSignal.timeout(4000) });
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

export interface GlossResponse extends GlossResult {
  warning?: string;
  ms?: number;
}

export async function translateToGloss(
  text: string,
  signs: SignEntry[],
  opts: { model: ClaudeModel; mode: GlossMode; signal?: AbortSignal },
): Promise<GlossResponse> {
  const r = await fetch("/api/gloss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      model: opts.model,
      mode: opts.mode,
      // Китепкана жана демо жесттер сервердин өзүндө бар — колдонуучунун жаздырууларын гана жиберебиз.
      vocabulary: signs.filter((s) => s.source === "recorded").map((s) => ({ gloss: s.gloss, aliases: s.aliases })),
    }),
    signal: opts.signal,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `Сервер катасы ${r.status}`);
  return data as GlossResponse;
}

/** Кыргызча үн (MMS-TTS кызматы иштесе). Иштебесе null. */
export async function fetchKyrgyzSpeech(text: string): Promise<Blob | null> {
  try {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return r.ok ? await r.blob() : null;
  } catch {
    return null;
  }
}

/** Таанылган глосстор → табигый кыргызча сүйлөм. */
export async function glossToSentence(
  gloss: string[],
  opts: { model: ClaudeModel; question?: boolean },
): Promise<{ sentence: string; engine: "claude" | "rules"; warning?: string }> {
  const r = await fetch("/api/sentence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gloss, question: opts.question ?? false, model: opts.model }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `Сервер катасы ${r.status}`);
  return data;
}
