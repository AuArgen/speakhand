// Алдын ала кысылган (.gz) статикалык файлдарды берет — жест китепканасы үчүн (public/signs/**).
// GET /signs/… сурамына: `.gz` эгизи бар жана браузер gzip кабыл алса — ошол файл
// `Content-Encoding: gzip` менен агым катары берилет (кысуу CPU'су керек эмес), ETag/304 менен.
// Болбосо false — Vite (иштеп чыгуу) же кадимки статика (dist) иштетет.
// Файлдарды tools/rsl_import түзөт: clips/<id>.json(.gz), manifest.json(.gz), templates.bin/json(.gz).
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** public/ — булак (иштеп чыгуу); dist/ — `vite build` көчүрмөсү (продакшн, public жок болсо) */
const ROOTS = [path.join(ROOT, "public"), path.join(ROOT, "dist")];
const PREFIX = "/signs/";

const TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function acceptsGzip(req: IncomingMessage): boolean {
  const h = req.headers["accept-encoding"];
  const v = Array.isArray(h) ? h.join(",") : h ?? "";
  for (const part of v.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (name !== "gzip" && name !== "*") continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (!q || Number(q.slice(2)) > 0) return true;
  }
  return false;
}

export async function tryServeGzip(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const raw = req.url ?? "/";
  if (!raw.startsWith(PREFIX)) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(raw, "http://x").pathname);
  } catch {
    return false;
  }
  if (pathname.endsWith(".gz") || !acceptsGzip(req)) return false;

  for (const root of ROOTS) {
    const file = path.join(root, pathname);
    if (!file.startsWith(root + path.sep)) return false; // ../ аркылуу чыгуу
    let st;
    try {
      st = await stat(file + ".gz");
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const etag = `W/"gz-${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers: Record<string, string | number> = {
      "Content-Type": TYPES[path.extname(pathname).toLowerCase()] ?? "application/octet-stream",
      "Content-Encoding": "gzip",
      "Cache-Control": "public, max-age=86400",
      ETag: etag,
      Vary: "Accept-Encoding",
      "Last-Modified": new Date(st.mtimeMs).toUTCString(),
    };
    const inm = req.headers["if-none-match"];
    if (inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) {
      res.writeHead(304, { ETag: etag, "Cache-Control": headers["Cache-Control"] as string, Vary: "Accept-Encoding" });
      res.end();
      return true;
    }
    headers["Content-Length"] = st.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    await new Promise<void>((resolve) => {
      const s = createReadStream(file + ".gz");
      s.on("error", () => {
        res.destroy();
        resolve();
      });
      s.on("end", () => resolve());
      s.pipe(res);
    });
    return true;
  }
  return false;
}
