// LAN үчүн жардамчылар: ушул компьютердин IPv4 даректери, өзү кол койгон HTTPS сертификаты
// жана бир порттогу HTTP → HTTPS багыттоо (телефон камерасы/микрофону коопсуз дарек талап кылат).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { RequestListener, Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const VIRTUAL_IF = /vethernet|virtualbox|vmware|vbox|wsl|hyper-v|docker|loopback|tailscale|zerotier|bluetooth|vpn|tap|tun/i;

function privateRank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

/** Ички эмес IPv4 даректер (169.254.* жок), чыныгы тармак адаптерлери биринчи. */
export function lanAddresses(): string[] {
  const found: { ip: string; virtual: boolean }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      found.push({ ip: a.address, virtual: VIRTUAL_IF.test(name) });
    }
  }
  found.sort((a, b) => Number(a.virtual) - Number(b.virtual) || privateRank(a.ip) - privateRank(b.ip));
  return [...new Set(found.map((f) => f.ip))];
}

export function lanUrls(https: boolean, port: number): string[] {
  return lanAddresses().map((ip) => `${https ? "https" : "http"}://${ip}:${port}`);
}

interface CertMeta {
  ips: string[];
  hosts: string[];
  notAfter: number;
}

export interface TlsPair {
  key: string;
  cert: string;
}

/**
 * dir ичиндеги сертификатты окуйт; жок болсо, мөөнөтү бүтө турган болсо же жаңы LAN дареги
 * пайда болсо — жаңысын түзөт (localhost + бардык LAN IP subjectAltName'де).
 */
export async function ensureCert(dir: string, log: (m: string) => void = console.log): Promise<TlsPair> {
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  const metaFile = path.join(dir, "meta.json");
  const ips = lanAddresses();
  const hostname = os.hostname().toLowerCase();
  const hosts = ["localhost", hostname, `${hostname}.local`];
  try {
    const [key, cert, metaRaw] = await Promise.all([
      readFile(keyFile, "utf8"),
      readFile(certFile, "utf8"),
      readFile(metaFile, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as CertMeta;
    const covered = ips.every((ip) => meta.ips.includes(ip)) && hosts.every((h) => meta.hosts.includes(h));
    if (covered && meta.notAfter - Date.now() > 30 * 24 * 3600 * 1000) return { key, cert };
  } catch {
    /* жок же бузулган — жаңысын түзөбүз */
  }

  // Мурунку IP'лерди да калтырабыз — тармак алмашса сертификат кайра-кайра өзгөрбөсүн.
  let prevIps: string[] = [];
  try {
    prevIps = (JSON.parse(await readFile(metaFile, "utf8")) as CertMeta).ips ?? [];
  } catch {
    /* эч нерсе */
  }
  const allIps = [...new Set([...ips, ...prevIps])].slice(0, 32);
  const { generate } = await import("selfsigned");
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  // Apple түзмөктөрү 825 күндөн узун сертификатты кабыл албайт — 397 күн.
  const notAfter = new Date(notBefore.getTime() + 397 * 24 * 3600 * 1000);
  const pems = await generate([{ name: "commonName", value: "Suylo LAN" }], {
    keyType: "rsa",
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          ...hosts.map((value) => ({ type: 2 as const, value })),
          { type: 7 as const, ip: "127.0.0.1" },
          { type: 7 as const, ip: "::1" },
          ...allIps.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  await mkdir(dir, { recursive: true });
  const meta: CertMeta = { ips: allIps, hosts, notAfter: notAfter.getTime() };
  await Promise.all([
    writeFile(keyFile, pems.private, { encoding: "utf8", mode: 0o600 }),
    writeFile(certFile, pems.cert, "utf8"),
    writeFile(metaFile, JSON.stringify(meta, null, 1), "utf8"),
  ]);
  log(`✓ Жаңы HTTPS сертификаты түзүлдү: ${certFile}`);
  return { key: pems.private, cert: pems.cert };
}

export interface DualServer {
  /** Бардык суроо-талаптар ушул HTTPS серверге келет (upgrade окуялары да). */
  https: HttpsServer;
  /** TCP тыңшоочу: биринчи байтка карап TLS же жөнөкөй HTTP'ге бөлөт. */
  tcp: net.Server;
  /** Ачык сокеттерди жабат */
  destroyAll(): void;
}

/**
 * Бир порт: TLS (биринчи байт 0x16) → HTTPS сервер; жөнөкөй HTTP → https://'ке 308 багыттоо.
 * Телефондо «192.168.1.5:8787» деп терилсе да туура ачылат.
 */
export function createDualServer(tls: TlsPair, handler: RequestListener): DualServer {
  const https = createHttpsServer({ key: tls.key, cert: tls.cert }, handler);
  const redirect: HttpServer = createHttpServer((req, res) => {
    const host = req.headers.host ?? "localhost";
    res.writeHead(308, { location: `https://${host}${req.url ?? "/"}`, "content-type": "text/plain; charset=utf-8" });
    res.end("HTTPS колдонуңуз\n");
  });
  redirect.on("upgrade", (_req, socket) => socket.destroy());
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30_000, () => {
      // Эч нерсе жөнөтпөгөн туташуу
      if (!socket.readableLength && socket.bytesRead === 0) socket.destroy();
    });
    socket.once("data", (buf: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(buf);
      if (buf[0] === 0x16) https.emit("connection", socket);
      else if (buf[0] >= 0x20 && buf[0] < 0x7f) redirect.emit("connection", socket);
      else return socket.destroy();
      process.nextTick(() => socket.resume());
    });
  });
  return {
    https,
    tcp,
    destroyAll() {
      for (const s of sockets) s.destroy();
    },
  };
}
