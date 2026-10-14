// Hash негизиндеги маршруттар: #/ (башкы), #/r/<код> (бөлмө), #/<курал> (эски куралдар).
import { useEffect, useState } from "react";

export const TOOLS = ["translate", "recognize", "studio", "dictionary"] as const;
export type ToolId = (typeof TOOLS)[number];

export type Route = { kind: "home" } | { kind: "room"; code: string } | { kind: "tool"; tool: ToolId };

export const isCode = (s: string) => /^\d{6}$/.test(s);

export function parseHash(hash = location.hash): Route {
  const clean = hash.replace(/^#\/?/, "").split("?")[0].replace(/\/+$/, "");
  const room = clean.match(/^r\/(\d{6})$/);
  if (room) return { kind: "room", code: room[1] };
  if ((TOOLS as readonly string[]).includes(clean)) return { kind: "tool", tool: clean as ToolId };
  return { kind: "home" };
}

export function navigate(to: string) {
  const next = to.startsWith("#") ? to : `#${to.startsWith("/") ? "" : "/"}${to}`;
  if (location.hash === next) return;
  location.hash = next;
}

export const roomHash = (code: string) => `#/r/${code}`;

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
