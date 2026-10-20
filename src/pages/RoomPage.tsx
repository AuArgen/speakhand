// Бөлмө: эки түзмөктөгү эки адамдын сүйлөшүүсү. Роль боюнча эки көрүнүш (сүйлөөчү / жаңсоочу).
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConnectionBanner } from "../components/room/ConnectionBanner";
import { InviteSheet } from "../components/room/InviteSheet";
import { QuickPhrases } from "../components/room/QuickPhrases";
import { ROLE_LABEL, RoleCards } from "../components/room/RoleCards";
import { RoomHeader } from "../components/room/RoomHeader";
import { SettingsSheet } from "../components/room/SettingsSheet";
import { Sheet } from "../components/room/Sheet";
import type { SignerStageHandle } from "../components/room/SignerStage";
import { SpeakerComposer } from "../components/room/SpeakerComposer";
import { Timeline } from "../components/room/Timeline";
import { loadRecentPhrases, pushRecentPhrase } from "../components/room/phraseGroups";
import { useRoomSettings } from "../components/room/settings";
import { IconInfo } from "../components/icons";
import { IconBack } from "../components/room/roomIcons";
import { useFlash, useTitleBlink, vibrate } from "../hooks/useHaptics";
import { navigate } from "../hooks/useHashRoute";
import { useWide } from "../hooks/useMediaQuery";
import { loadName, recentRoom, rememberRoom, saveName } from "../hooks/useRecentRooms";
import { useRoom, type TimelineItem } from "../hooks/useRoom";
import type { ClaudeModel } from "../lib/api";
import { indexPhrases } from "../lib/compose";
import { useRecognizer } from "../lib/recognizer";
import { useDictionary } from "../lib/useDictionary";
import { checkRoom, fetchPhrases, type PhraseItem, type Role, type RoomSummary } from "../lib/room";
import { speak } from "../lib/speech";

// 3D аватар (three.js) жана камера (MediaPipe) жаңсоочуга гана керек — сүйлөөчүнүн телефону аларды жүктөбөйт.
const SignerStage = lazy(() => import("../components/room/SignerStage").then((m) => ({ default: m.SignerStage })));
const SignerTools = lazy(() => import("../components/room/SignerTools").then((m) => ({ default: m.SignerTools })));

export function RoomPage(props: {
  code: string;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  model: ClaudeModel;
  claudeReady: boolean;
  /** Кыргызча MMS-TTS кызматы иштеп жатабы (жок болсо — браузердин үнү, сервер суралбайт) */
  ttsService: boolean;
  toast: (m: string) => void;
}) {
  const [role, setRole] = useState<Role | null>(() => recentRoom(props.code)?.role ?? null);
  const [name, setName] = useState(() => recentRoom(props.code)?.name ?? loadName());

  function chooseRole(r: Role, n: string) {
    setName(n);
    saveName(n);
    rememberRoom({ code: props.code, role: r, name: n });
    setRole(r);
  }

  if (!role) return <RoleGate code={props.code} name={name} onPick={chooseRole} />;
  return <RoomInner key={role} {...props} role={role} name={name} onChangeRole={() => setRole(null)} />;
}

// ----------------------------------------------------------------------------

function RoleGate(props: { code: string; name: string; onPick: (r: Role, name: string) => void }) {
  const [name, setName] = useState(props.name);
  const [room, setRoom] = useState<RoomSummary | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    checkRoom(props.code)
      .then((r) => alive && setRoom(r))
      .catch((e) => alive && (setError((e as Error).message), setRoom(undefined)));
    return () => { alive = false; };
  }, [props.code]);

  const inside = room?.participants ?? [];
  const online = inside.filter((p) => p.online);
  const taken = new Set((online.length ? online : inside).map((p) => p.role));
  const suggest: Role | null = taken.has("speaker") && !taken.has("signer") ? "signer" : taken.has("signer") && !taken.has("speaker") ? "speaker" : null;

  return (
    <div className="room gate">
      <header className="rm-head">
        <button className="rm-iconbtn" onClick={() => navigate("/")} aria-label="Башкы бетке"><IconBack /></button>
        <div className="rm-code static"><span className="rm-code-digits">{props.code.slice(0, 3)}<i /> {props.code.slice(3)}</span></div>
      </header>
      <div className="gate-body">
        {room === undefined && !error && <div className="muted" style={{ textAlign: "center" }}><span className="spinner" style={{ verticalAlign: -3, marginRight: 8 }} /> Бөлмө текшерилип жатат…</div>}
        {room === null && (
          <div className="notice error"><IconInfo /> <span>Мындай бөлмө жок. Код туура эмес же бөлмө өчүрүлгөн.</span></div>
        )}
        {error && <div className="notice error"><IconInfo /> {error}</div>}
        {room && (
          <>
            <div className="home-panel-head" style={{ textAlign: "center" }}>
              <h2>Сиз кимсиз?</h2>
              <p className="muted">
                {inside.length
                  ? <>Ичинде: {inside.map((p) => `${p.name || ROLE_LABEL[p.role]} (${p.role === "speaker" ? "сүйлөйт" : "жаңсайт"})`).join(", ")}.{suggest ? ` Сизге «${ROLE_LABEL[suggest]}» сунушталат.` : ""}</>
                  : "Бөлмө бош — сиз биринчисиз."}
              </p>
            </div>
            <RoleCards value={null} onPick={(r) => props.onPick(r, name.trim())} suggest={suggest} />
            <label className="name-field">
              <span>Атыңыз <span className="muted">(каалоо боюнча)</span></span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Мисалы: Айгүл" maxLength={32} aria-label="Атыңыз" />
            </label>
          </>
        )}
        {(room === null || error) && <button className="btn" onClick={() => navigate("/")}>Башкы бетке</button>}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------

function RoomInner(props: {
  code: string;
  role: Role;
  name: string;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  model: ClaudeModel;
  claudeReady: boolean;
  ttsService: boolean;
  toast: (m: string) => void;
  onChangeRole: () => void;
}) {
  const { code, role, name, toast } = props;
  const ttsService = useRef(props.ttsService);
  ttsService.current = props.ttsService;
  const say = useCallback((text: string) => {
    (ttsService.current ? speak(text) : speakInBrowser(text)).catch(() => {});
  }, []);
  const room = useRoom({ code, role, name });
  const settings = useRoomSettings();
  const wide = useWide();
  const recognizer = useRecognizer(role === "signer");
  const { signs, loading: signsLoading } = useDictionary();
  const [phrases, setPhrases] = useState<PhraseItem[]>([]);
  const [phrasesLoading, setPhrasesLoading] = useState(true);
  const phraseIndex = useMemo(() => indexPhrases(phrases), [phrases]);
  const [recentPhrases, setRecentPhrases] = useState<string[]>(loadRecentPhrases);
  const [sheet, setSheet] = useState<"invite" | "settings" | "chat" | "phrases" | null>(null);
  const [flash, triggerFlash] = useFlash();
  const [unread, setUnread] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const stage = useRef<SignerStageHandle | null>(null);
  // Аватар (өзүнчө файл) жүктөлүп бүткөнчө келген билдирүүлөр жоголбосун — кезекте күтөт.
  const pendingForStage = useRef<TimelineItem[]>([]);
  const attachStage = useCallback((h: SignerStageHandle | null) => {
    stage.current = h;
    if (h) for (const m of pendingForStage.current.splice(0)) h.enqueue(m);
  }, []);
  const welcomed = room.room !== null;

  useEffect(() => {
    fetchPhrases().then((p) => { setPhrases(p); setPhrasesLoading(false); });
  }, []);

  // Акыркы бөлмөлөр: маектештин аты белгилүү болгондо жаңыртабыз
  useEffect(() => {
    if (welcomed) rememberRoom({ code, role, name, partner: room.partner?.name || undefined });
  }, [welcomed, code, role, name, room.partner?.name]);

  // Жаңы келген билдирүү: вибрация + жаркылдоо; сүйлөөчүгө — үн; жаңсоочуга — аватар
  const incoming = room.incoming;
  const settingsRef = useRef(settings.s);
  settingsRef.current = settings.s;
  useEffect(() => {
    if (!incoming) return;
    const s = settingsRef.current;
    if (s.vibrate) vibrate(role === "signer" ? [80, 50, 80] : 40);
    triggerFlash();
    if (role === "speaker") {
      if (s.tts) say(incoming.text);
    } else {
      const item = { ...incoming, pending: false, mine: false };
      if (stage.current) stage.current.enqueue(item);
      else pendingForStage.current.push(item);
      if (!wide && sheet !== "chat") setUnread((u) => u + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, say]);

  useEffect(() => {
    if (sheet === "chat" || wide) setUnread(0);
  }, [sheet, wide]);

  useTitleBlink(unread);

  const onPhraseUsed = useCallback((t: string) => setRecentPhrases(pushRecentPhrase(t)), []);

  function pickPhraseAsSpeaker(p: PhraseItem) {
    room.send(p.text, { via: "quick", gloss: p.gloss });
    onPhraseUsed(p.text);
    setSheet(null);
  }

  function replay(item: TimelineItem) {
    if (role === "speaker") say(item.text);
    else {
      stage.current?.replay(item);
      if (!wide) setSheet(null);
    }
  }

  function leave() {
    setSheet(null);
    navigate("/");
  }

  const lastPartnerText = useMemo(() => [...room.messages].reverse().find((m) => !m.mine)?.text, [room.messages]);

  const emptyTimeline = (
    <div className="tl-empty">
      <b>{room.partner ? "Сүйлөшүү башталсын!" : "Маектешти чакырыңыз"}</b>
      <span>{room.partner
        ? role === "speaker" ? "Микрофонду басып сүйлөңүз же жазыңыз — маектешке аватар жест менен көрсөтөт." : "Жест көрсөтүңүз же даяр сүйлөмгө басыңыз — маектешке үн менен окулат."
        : <>Жогорудагы <b>QR</b> баскычын басып, кодду же шилтемени бериңиз. Код: <b>{code}</b></>}</span>
    </div>
  );

  const timeline = (
    <Timeline items={room.messages} partner={room.partner} partnerStatus={room.partnerStatus} viewerRole={role} onReplay={replay} activeId={activeId} empty={emptyTimeline} compact={role === "signer"} />
  );

  const sheets = (
    <>
      <InviteSheet open={sheet === "invite"} onClose={() => setSheet(null)} code={code} toast={toast} theme={props.theme} />
      <SettingsSheet
        open={sheet === "settings"}
        onClose={() => setSheet(null)}
        role={role}
        settings={settings}
        theme={props.theme}
        setTheme={props.setTheme}
        claudeReady={props.claudeReady}
        onChangeRole={() => { setSheet(null); props.onChangeRole(); }}
        onLeave={leave}
      />
      {role === "signer" && !wide && (
        <Sheet open={sheet === "chat"} onClose={() => setSheet(null)} title="Сүйлөшүү" tall>
          {timeline}
        </Sheet>
      )}
      {role === "speaker" && !wide && (
        <Sheet open={sheet === "phrases"} onClose={() => setSheet(null)} title="Даяр сүйлөмдөр" tall>
          <QuickPhrases phrases={phrases} recent={recentPhrases} onPick={pickPhraseAsSpeaker} loading={phrasesLoading} autoFocus={false} />
        </Sheet>
      )}
    </>
  );

  const header = (
    <RoomHeader
      code={code}
      participants={room.participants}
      meId={room.you?.clientId ?? null}
      state={room.state}
      onBack={() => navigate("/")}
      onInvite={() => setSheet("invite")}
      onSettings={() => setSheet("settings")}
      onChat={role === "signer" && !wide ? () => setSheet("chat") : undefined}
      unread={unread}
      toast={toast}
    />
  );

  const banner = (
    <>
      <ConnectionBanner state={room.state} error={room.error} welcomed={welcomed} onRetry={room.reconnect} onHome={() => navigate("/")} />
      {/* Маектеш али кире элек — так айтабыз (телефондо башкы тилкеде орун жок) */}
      {welcomed && room.state === "open" && !room.partner && (
        <button className="rm-wait" onClick={() => setSheet("invite")}>
          <span className="spinner" aria-hidden />
          <span className="rm-wait-text">Маектеш али кире элек · код <b>{code.slice(0, 3)} {code.slice(3)}</b></span>
          <span className="rm-wait-cta">Чакыруу →</span>
        </button>
      )}
    </>
  );
  const disabled = Boolean(room.error && (room.error.code === "not_found" || room.error.code === "room_full"));

  if (role === "speaker") {
    return (
      <div className={`room speaker ${flash ? "flash" : ""} ${wide ? "wide" : ""}`}>
        {header}
        {banner}
        <div className="rm-body">
          <div className="rm-main">
            {timeline}
            <SpeakerComposer send={room.send} setStatus={room.setStatus} sttLang={settings.s.sttLang} onOpenPhrases={wide ? undefined : () => setSheet("phrases")} disabled={disabled} wide={wide} />
          </div>
          {wide && (
            <aside className="rm-side">
              <div className="rm-side-head"><h2 className="card-title">Даяр сүйлөмдөр</h2><span className="muted">бир басуу — дароо жөнөтүлөт</span></div>
              <QuickPhrases phrases={phrases} recent={recentPhrases} onPick={pickPhraseAsSpeaker} loading={phrasesLoading} />
            </aside>
          )}
        </div>
        {sheets}
      </div>
    );
  }

  return (
    <div className={`room signer ${flash ? "flash" : ""} ${wide ? "wide" : ""}`}>
      {header}
      {banner}
      <div className="rm-body">
        <div className="rm-main">
          <Suspense fallback={<div className="rm-stage-loading"><span className="spinner" /> 3D аватар жүктөлүүдө…</div>}>
          <SignerStage
            ref={attachStage}
            theme={props.theme}
            speed={settings.s.speed}
            signs={signs}
            glossMode={props.claudeReady ? settings.glossMode : "offline"}
            model={props.model}
            flash={flash}
            onActive={setActiveId}
            lastText={lastPartnerText}
          />
          </Suspense>
          {wide && timeline}
        </div>
        <aside className="rm-side">
          <Suspense fallback={<div className="rm-stage-loading"><span className="spinner" /> Жүктөлүүдө…</div>}>
          <SignerTools
            send={room.send}
            setStatus={room.setStatus}
            phrases={phrases}
            phraseIndex={phraseIndex}
            phrasesLoading={phrasesLoading}
            recentPhrases={recentPhrases}
            onPhraseUsed={onPhraseUsed}
            signs={signs}
            signsLoading={signsLoading}
            recognizer={recognizer}
            settings={settings.s}
          />
          </Suspense>
          <a className="rm-learn-link" href="#/learn" target="_blank" rel="noopener">🎓 Жест тилин үйрөнүү жана машыгуу ↗</a>
        </aside>
      </div>
      {sheets}
    </div>
  );
}

/** Браузердин үнү (кыргыз TTS кызматы жок болгондо — серверге суроо жиберилбейт). */
async function speakInBrowser(text: string): Promise<void> {
  if (!("speechSynthesis" in window) || !text.trim()) return;
  speechSynthesis.cancel();
  const voices = speechSynthesis.getVoices();
  const voice =
    voices.find((v) => v.lang.toLowerCase().startsWith("ky")) ??
    voices.find((v) => v.lang.toLowerCase().startsWith("kk")) ??
    voices.find((v) => v.lang.toLowerCase().startsWith("ru"));
  const u = new SpeechSynthesisUtterance(text);
  if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = "ky-KG";
  u.rate = 0.95;
  speechSynthesis.speak(u);
}
