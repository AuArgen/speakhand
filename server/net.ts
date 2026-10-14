// Кардардын IP дареги. Railway сыяктуу прокси артында (TRUST_PROXY=1) — X-Forwarded-For'дун биринчиси,
// болбосо бардык колдонуучулар проксинин бир IP'синде калып, лимиттер баарына чогуу тиет.
import type { IncomingMessage } from "node:http";

const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";

export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "";
}
