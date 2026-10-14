// Чакыруу: QR код + шилтеме + 6 сандуу код. localhost'то LAN https дареги тандалат — телефон ача алсын.
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { fetchNetInfo } from "../../lib/room";
import { roomHash } from "../../hooks/useHashRoute";
import { IconCheck, IconCopy, IconLink, IconShare } from "./roomIcons";
import { Sheet } from "./Sheet";

const isLocal = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(h);

export async function roomLink(code: string): Promise<{ url: string; lan: boolean }> {
  const here = `${location.origin}${location.pathname}${roomHash(code)}`;
  if (!isLocal(location.hostname)) return { url: here, lan: false };
  try {
    const net = await fetchNetInfo();
    const base = net.urls.find((u) => u.startsWith("https://")) ?? net.urls[0];
    if (base) return { url: `${base.replace(/\/$/, "")}${location.pathname}${roomHash(code)}`, lan: true };
  } catch {
    /* LAN дареги жок — локалдык шилтеме */
  }
  return { url: here, lan: false };
}

export function InviteSheet(props: { open: boolean; onClose: () => void; code: string; toast: (m: string) => void; theme: "dark" | "light" }) {
  const [link, setLink] = useState<{ url: string; lan: boolean } | null>(null);
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    roomLink(props.code).then(async (l) => {
      if (!alive) return;
      setLink(l);
      try {
        const dark = props.theme === "dark" ? "#f5f2ed" : "#141828";
        const data = await QRCode.toDataURL(l.url, { margin: 1, width: 640, errorCorrectionLevel: "M", color: { dark, light: "#00000000" } });
        if (alive) setQr(data);
      } catch {
        if (alive) setQr("");
      }
    });
    return () => { alive = false; };
  }, [props.open, props.code, props.theme]);

  async function copy(what: "code" | "link") {
    const text = what === "code" ? props.code : link?.url ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      props.toast(what === "code" ? "Код көчүрүлдү" : "Шилтеме көчүрүлдү");
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      props.toast(text);
    }
  }

  async function share() {
    if (!link) return;
    const data = { title: "Сүйлө — сүйлөшүү бөлмөсү", text: `Сүйлөшүү бөлмөсүнө кириңиз. Код: ${props.code}`, url: link.url };
    try {
      if (navigator.share) await navigator.share(data);
      else await copy("link");
    } catch {
      /* колдонуучу жокко чыгарды */
    }
  }

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Экинчи адамды чакыруу">
      <div className="invite">
        <div className="invite-qr" aria-label="QR код">
          {qr ? <img src={qr} alt={`Бөлмө ${props.code} үчүн QR код`} /> : <span className="spinner" />}
        </div>
        <p className="invite-hint">Телефондун камерасы менен QR'ды сканерлеңиз — же кодду айтып бериңиз:</p>
        <button className="invite-code" onClick={() => copy("code")} aria-label="Кодду көчүрүү">
          <span>{props.code.slice(0, 3)}</span><span className="sep" /><span>{props.code.slice(3)}</span>
          <span className="invite-copy">{copied === "code" ? <IconCheck /> : <IconCopy />}</span>
        </button>
        {link && (
          <div className="invite-link">
            <IconLink />
            <span className="invite-url">{link.url.replace(/^https?:\/\//, "")}</span>
            {link.lan && <span className="chip rec" title="Бир Wi-Fi'дагы телефон ача алат">LAN</span>}
          </div>
        )}
        <div className="invite-actions">
          <button className="btn btn-primary" onClick={share} disabled={!link}>
            <IconShare /> {typeof navigator.share === "function" ? "Бөлүшүү" : "Шилтемени көчүрүү"}
          </button>
          <button className="btn" onClick={() => copy("link")} disabled={!link}>{copied === "link" ? <IconCheck /> : <IconCopy />} Шилтеме</button>
        </div>
        <p className="muted" style={{ margin: 0, textAlign: "center" }}>Кийин да ушул код менен кирип, сүйлөшүүнү улантса болот.</p>
      </div>
    </Sheet>
  );
}
