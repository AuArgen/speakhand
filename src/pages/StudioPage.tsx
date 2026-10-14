// Студия: чыныгы адамдан жестти видео аркылуу жаздыруу (motion capture).
// Бир жаздыруу эки ишке кетет: аватар ошол кыймылды кайталайт + классификатор үйрөнөт.
import { useEffect, useRef, useState } from "react";
import { AvatarView, type AvatarHandle } from "../components/AvatarView";
import { CameraView } from "../components/CameraView";
import { IconCamera, IconInfo, IconPlay, IconRecord, IconStop, IconX } from "../components/icons";
import { normalizeGloss, saveSign } from "../data/store";
import { findSign } from "../lib/useDictionary";
import { useStored } from "../lib/settings";
import type { MocapClip, SignEntry } from "../lib/types";
import { ClipRecorder, type TrackResult } from "../vision";

const TARGET = 5;

export function StudioPage(props: { theme: "dark" | "light"; initialGloss?: string; toast: (m: string) => void }) {
  const avatar = useRef<AvatarHandle>(null);
  const [gloss, setGloss] = useState(props.initialGloss ?? "");
  const [aliases, setAliases] = useState("");
  const [existing, setExisting] = useState<SignEntry | null>(null);
  const [samples, setSamples] = useState<MocapClip[]>([]);
  const [main, setMain] = useState(0);
  const [on, setOn] = useState(false);
  const [face, setFace] = useStored("studioFace", true);
  const [mirror, setMirror] = useStored("studioMirror", true);
  const [duration, setDuration] = useStored("studioDuration", 2.5);
  const [phase, setPhase] = useState<"idle" | "count" | "rec">("idle");
  const [count, setCount] = useState(3);
  const [saving, setSaving] = useState(false);
  const recorder = useRef<ClipRecorder | null>(null);
  const timers = useRef<number[]>([]);
  const previewing = useRef(false);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;

  // Глосс өзгөргөндө — сөздүктө бар болсо жүктөйбүз.
  useEffect(() => {
    const g = normalizeGloss(gloss);
    if (!g) { setExisting(null); return; }
    let alive = true;
    const t = window.setTimeout(async () => {
      const e = await findSign(g);
      if (!alive) return;
      setExisting(e ?? null);
      if (e) {
        setAliases(e.aliases.join(", "));
        setSamples(e.samples);
        // IndexedDB'ден кийин объект бирдейлиги жоголот — мазмуну боюнча салыштырабыз.
        const sig = (c: SignEntry["clip"]) => (!c ? "none" : c.kind === "mocap" ? `${c.frames.length}:${c.frames.at(-1)?.t}` : "kf");
        setMain(Math.max(0, e.samples.findIndex((s) => sig(s) === sig(e.clip))));
      } else {
        setSamples([]);
        setMain(0);
      }
    }, 250);
    return () => { alive = false; window.clearTimeout(t); };
  }, [gloss]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => { if (!on || !mirror) avatar.current?.setLiveFrame(null); }, [on, mirror]);

  function onFrame(res: TrackResult) {
    if (mirrorRef.current && !previewing.current) avatar.current?.setLiveFrame(res.frame);
    recorder.current?.push(res.frame);
  }

  function record() {
    if (phase !== "idle") return;
    setPhase("count");
    setCount(3);
    const at = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    at(1000, () => setCount(2));
    at(2000, () => setCount(1));
    at(3000, () => {
      const r = new ClipRecorder();
      r.start();
      recorder.current = r;
      setPhase("rec");
      at(duration * 1000, finish);
    });
  }

  function finish() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const r = recorder.current;
    recorder.current = null;
    setPhase("idle");
    if (!r) return;
    const clip = r.stop();
    const withHands = clip.frames.filter((f) => f.leftHand || f.rightHand).length;
    if (clip.frames.length < 10 || withHands < clip.frames.length * 0.3) {
      props.toast("Колдор жетиштүү көрүнгөн жок — кайра жаздырыңыз");
      return;
    }
    setSamples((s) => [...s, clip]);
  }

  async function preview(clip: MocapClip) {
    previewing.current = true;
    avatar.current?.setLiveFrame(null);
    try {
      await avatar.current?.play([{ gloss: normalizeGloss(gloss) || "ЖЕСТ", clip }]);
    } finally {
      previewing.current = false;
    }
  }

  async function save() {
    const g = normalizeGloss(gloss);
    if (!g || !samples.length) return;
    setSaving(true);
    const entry: SignEntry = {
      gloss: g,
      aliases: aliases.split(",").map((a) => a.trim().toLocaleLowerCase("ky-KG")).filter(Boolean),
      clip: samples[Math.min(main, samples.length - 1)],
      samples,
      source: "recorded",
      // китепкана жесттинин келип чыгышы (орусча аты, сабак) сакталат
      ...(existing?.meta ? { meta: existing.meta } : {}),
      createdAt: existing?.createdAt || Date.now(),
    };
    await saveSign(entry);
    setExisting(entry);
    setSaving(false);
    props.toast(`«${g}» сакталды · ${samples.length} мисал`);
  }

  const g = normalizeGloss(gloss);

  return (
    <div className="grid-2">
      <div className="stack">
        <CameraView active={on} face={face} onFrame={onFrame} accent="#3dd6c3">
          {phase === "count" && <div className="count" key={count}>{count}</div>}
          {phase === "rec" && <div className="rec-ring" />}
          {phase === "rec" && <div className="signal"><span className="chip live" style={{ padding: 0, border: 0, background: "none" }}><span className="dot" /></span> Жазылууда…</div>}
          {!on && (
            <div className="stage-center">
              <div style={{ maxWidth: 360 }}>
                <p style={{ color: "var(--text-2)", marginTop: 0 }}>Камерага белге чейин көрүнгүдөй туруңуз. Жарык жүзүңүзгө түшсүн, артыңыздагы фон жөнөкөй болсун.</p>
                <button className="btn btn-primary" onClick={() => setOn(true)}><IconCamera /> Камераны күйгүзүү</button>
              </div>
            </div>
          )}
        </CameraView>

        <div className="card card-pad">
          <div className="row">
            {on && <button className="btn btn-sm" onClick={() => { setOn(false); finish(); }}><IconStop /> Камераны өчүрүү</button>}
            <label className="switch"><input type="checkbox" checked={face} onChange={(e) => setFace(e.target.checked)} /> Бет мимикасы</label>
            <label className="switch"><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} /> Аватар түз кайталайт</label>
            <div className="spacer" />
            <div className="seg" role="group" aria-label="Жаздыруу узактыгы">
              {[1.5, 2.5, 4].map((d) => (
                <button key={d} aria-pressed={duration === d} onClick={() => setDuration(d)}>{d} с</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="page-intro">
          <h1>Студия: чыныгы жестти жаздыруу</h1>
          <p>Жест тилин билген адам жестти камерага көрсөтөт. Кол, манжа жана бет кыймылы тартылып алынат: аватар аны ошол бойдон кайталайт, ал эми таануу системасы ошол мисалдардан үйрөнөт.</p>
        </div>

        <div className="card card-pad stack" style={{ gap: 14 }}>
          <div className="field">
            <label htmlFor="g">Глосс (сөз)</label>
            <input id="g" className="input big" value={gloss} onChange={(e) => setGloss(e.target.value)} placeholder="МИСАЛЫ: РАХМАТ" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="a">Сөз формалары жана синонимдер (үтүр менен)</label>
            <input id="a" className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="рахмат, ыраазымын, чоң рахмат" />
          </div>
          {existing && (
            <div className="row">
              <span className={`chip ${existing.source === "demo" ? "demo" : "rec"}`}>{existing.source === "demo"
                  ? "Демо жест — жаздыруу аны алмаштырат"
                  : existing.source === "library"
                    ? "Видеосабактагы жест бар — сиздин жаздырууңуз артыкчылыктуу болот"
                    : "Сөздүктө бар"}</span>
            </div>
          )}
          <div className="row">
            <button className="btn btn-primary" onClick={record} disabled={!on || !g || phase !== "idle"}>
              <IconRecord /> {phase === "idle" ? "Жаздыруу" : phase === "count" ? "Даярданыңыз…" : "Жазылууда…"}
            </button>
            <div className="progress-dots" aria-label={`${samples.length}/${TARGET} мисал`}>
              {Array.from({ length: TARGET }, (_, i) => <i key={i} className={i < samples.length ? "on" : ""} />)}
            </div>
            <span className="muted">{samples.length}/{TARGET}</span>
          </div>
          {!on && <div className="muted">Жаздыруу үчүн камераны күйгүзүңүз.</div>}
        </div>

        <AvatarView ref={avatar} theme={props.theme} className="studio-avatar">
          <div className="stage-overlay"><div className="stage-top"><span className="chip"><span className="dot" style={{ background: "var(--teal)" }} /> {mirror && on ? "Түз көчүрүү" : "Алдын ала көрүү"}</span></div></div>
        </AvatarView>

        <div className="card card-pad">
          <div className="card-head">
            <h2 className="card-title">Мисалдар</h2>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={!g || !samples.length || saving}>
              {saving ? "Сакталууда…" : "Сөздүккө сактоо"}
            </button>
          </div>
          {samples.length ? (
            <div className="samples">
              {samples.map((s, i) => (
                <div key={i} className="sample" style={i === main ? { borderColor: "var(--accent)" } : undefined}>
                  <Thumb clip={s} />
                  <button className="btn btn-sm btn-icon btn-ghost x" aria-label="Өчүрүү" onClick={() => { setSamples((x) => x.filter((_, j) => j !== i)); if (main >= i && main > 0) setMain(main - 1); }}><IconX /></button>
                  <span className="n">#{i + 1} · {(s.frames.at(-1)!.t / 1000).toFixed(1)}с</span>
                  <div style={{ position: "absolute", bottom: 4, right: 4, display: "flex", gap: 2 }}>
                    <button className="btn btn-sm btn-icon btn-ghost" title="Аватарда көрүү" onClick={() => preview(s)}><IconPlay /></button>
                    <button className="btn btn-sm btn-icon btn-ghost" title="Аватар ушул мисалды колдонот" onClick={() => setMain(i)} style={{ color: i === main ? "var(--accent)" : undefined }}>★</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Ар бир жестти {TARGET} жолудан, бир аз ар башкача (ылдамдык, бурч) жаздырыңыз — таануу ишенимдүү болот.</p>
          )}
          <div className="notice" style={{ marginTop: 14 }}>
            <IconInfo /> <span>★ белгиси бар мисалды аватар көрсөтөт. Калгандары таануу үчүн колдонулат.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Жаздыруунун кичинекей сүрөтү: билектердин траекториясы + ортоңку кадрдын скелети. */
function Thumb({ clip }: { clip: MocapClip }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = (c.width = 220), H = (c.height = 220);
    const ctx = c.getContext("2d")!;
    const style = getComputedStyle(document.documentElement);
    const accent = style.getPropertyValue("--accent").trim() || "#ff9f6b";
    const teal = style.getPropertyValue("--teal").trim() || "#3dd6c3";
    const muted = style.getPropertyValue("--text-3").trim() || "#888";
    // three: +x = адамдын солу → экранда оңдо (бетме-бет карап турабыз); +y өйдө.
    const P = (v: number[]) => [W / 2 + v[0] * 230, H * 0.78 - v[1] * 230] as const;
    const wrists = { l: [] as (readonly [number, number])[], r: [] as (readonly [number, number])[] };
    for (const f of clip.frames) {
      if (!f.pose) continue;
      wrists.l.push(P(f.pose[15]));
      wrists.r.push(P(f.pose[16]));
    }
    const mid = clip.frames[Math.floor(clip.frames.length / 2)];
    if (mid?.pose) {
      ctx.strokeStyle = muted;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      for (const [a, b] of [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24]]) {
        const pa = P(mid.pose[a]), pb = P(mid.pose[b]);
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
      }
      const n = P(mid.pose[0]);
      ctx.beginPath(); ctx.arc(n[0], n[1], 14, 0, Math.PI * 2); ctx.stroke();
    }
    for (const [pts, col] of [[wrists.l, teal], [wrists.r, accent]] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
    }
  }, [clip]);
  return <canvas ref={ref} />;
}
