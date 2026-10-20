// Башкы бет: идея бир сапта, эки негизги аракет (бөлмө ачуу / код менен кирүү), акыркы бөлмөлөр.
import { useCallback, useEffect, useRef, useState } from "react";
import { CodeInput } from "../components/room/CodeInput";
import { ROLE_LABEL, ROLE_SHORT, RoleCards } from "../components/room/RoleCards";
import { IconArrow, IconHand, IconInfo, IconMic, IconPlus, IconX } from "../components/icons";
import { IconChevron, IconKeyboard, IconPhone, IconUsers } from "../components/room/roomIcons";
import { navigate, roomHash } from "../hooks/useHashRoute";
import { loadName, saveName, useRecentRooms } from "../hooks/useRecentRooms";
import { checkRoom, createRoom, type Role, type RoomSummary } from "../lib/room";
import { IconGrad } from "../components/learn/learnIcons";

type Mode = "idle" | "create" | "join";

export function HomePage() {
  const [mode, setMode] = useState<Mode>("idle");
  const [name, setName] = useState(loadName);
  const [creating, setCreating] = useState<Role | null>(null);
  const [code, setCode] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<RoomSummary | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState<Role | null>(null);
  const { rooms, remember, forget } = useRecentRooms();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== "idle") panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [mode]);

  function pickName(v: string) {
    setName(v);
    saveName(v);
  }

  async function create(role: Role) {
    if (creating) return;
    setCreating(role);
    setError("");
    try {
      const room = await createRoom(role, name.trim());
      remember({ code: room.code, role, name: name.trim() });
      navigate(roomHash(room.code));
    } catch (e) {
      setError((e as Error).message || "Бөлмө ачылган жок. Сервер иштеп жатабы?");
      setCreating(null);
    }
  }

  const check = useCallback(async (c: string) => {
    setChecking(true);
    setError("");
    try {
      const r = await checkRoom(c);
      setFound(r);
      if (!r) setError("Мындай бөлмө жок. Кодду текшериңиз.");
    } catch (e) {
      setFound(undefined);
      setError((e as Error).message || "Текшерүү ишке ашкан жок");
    } finally {
      setChecking(false);
    }
  }, []);

  function onCode(v: string) {
    setCode(v);
    if (v.length < 6) {
      setFound(undefined);
      setError("");
    }
  }

  function join(role: Role) {
    if (!found) return;
    setJoining(role);
    remember({ code: found.code, role, name: name.trim(), partner: found.participants.find((p) => p.role !== role)?.name });
    navigate(roomHash(found.code));
  }

  // Ичинде ким бар — тескери ролду сунуштайбыз
  const inside = found?.participants ?? [];
  const insideOnline = inside.filter((p) => p.online);
  const taken = new Set((insideOnline.length ? insideOnline : inside).map((p) => p.role));
  const suggest: Role | null = taken.has("speaker") && !taken.has("signer") ? "signer" : taken.has("signer") && !taken.has("speaker") ? "speaker" : null;

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-badge"><IconUsers /> Эки түзмөк · каттоосуз · дароо</div>
        <h1>Бири сүйлөйт, экинчиси жаңсайт — <em>экөө бири-бирин түшүнөт.</em></h1>
        <p>Сүйлөгөн адамдын сөзү жаңсоочунун телефонунда чоң текст жана 3D аватардын жести болуп чыгат. Жаңсоочунун жести — текст жана үн болуп сүйлөөчүгө жетет.</p>
      </section>

      <div className="home-actions">
        <button className={`big-action primary ${mode === "create" ? "active" : ""}`} onClick={() => setMode(mode === "create" ? "idle" : "create")} aria-expanded={mode === "create"}>
          <span className="big-action-icon"><IconPlus /></span>
          <span className="big-action-text"><b>Бөлмө ачуу</b><small>6 сандуу код чыгат — экинчи адамга бересиз</small></span>
          <IconChevron className="big-action-chev" />
        </button>
        <button className={`big-action ${mode === "join" ? "active" : ""}`} onClick={() => setMode(mode === "join" ? "idle" : "join")} aria-expanded={mode === "join"}>
          <span className="big-action-icon"><IconKeyboard /></span>
          <span className="big-action-text"><b>Код менен кирүү</b><small>Экинчи адам берген 6 санды жазыңыз</small></span>
          <IconChevron className="big-action-chev" />
        </button>
      </div>

      {mode === "create" && (
        <div ref={panel} className="home-panel card" role="region" aria-label="Бөлмө ачуу">
          <div className="home-panel-head">
            <h2>Сиз кимсиз?</h2>
            <p className="muted">Ролго басыңыз — бөлмө дароо ачылат.</p>
          </div>
          <RoleCards value={creating} onPick={create} busy={creating} disabled={Boolean(creating)} />
          <NameField value={name} onChange={pickName} />
          {error && <div className="notice error"><IconInfo /> {error}</div>}
        </div>
      )}

      {mode === "join" && (
        <div ref={panel} className="home-panel card" role="region" aria-label="Код менен кирүү">
          <div className="home-panel-head">
            <h2>Бөлмөнүн коду</h2>
            <p className="muted">6 сан — экинчи адамдын экранында же QR'да.</p>
          </div>
          <CodeInput value={code} onChange={onCode} onComplete={check} autoFocus invalid={found === null} />
          {checking && <div className="muted" style={{ textAlign: "center" }}><span className="spinner" style={{ verticalAlign: -3, marginRight: 8 }} /> Текшерилип жатат…</div>}
          {error && <div className="notice error"><IconInfo /> {error}</div>}
          {found && (
            <div className="join-found">
              <div className="join-inside">
                {inside.length ? (
                  <>
                    <span className="muted">Ичинде:</span>
                    {inside.map((p) => (
                      <span key={p.clientId} className={`chip ${p.online ? "ok" : ""}`}>
                        <span className="dot" /> {p.name || (p.role === "speaker" ? "Сүйлөөчү" : "Жаңсоочу")} · {ROLE_SHORT[p.role]}
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="muted">Бөлмө бош — сиз биринчи кирип жатасыз.</span>
                )}
                {found.messageCount > 0 && <span className="chip">{found.messageCount} билдирүү</span>}
              </div>
              <div className="home-panel-head" style={{ marginTop: 8 }}>
                <h2>Сиз кимсиз?</h2>
                {suggest && <p className="muted">Ичинде {ROLE_SHORT[suggest === "signer" ? "speaker" : "signer"]} адам бар — сизге «{ROLE_LABEL[suggest]}» сунушталат.</p>}
              </div>
              <RoleCards value={joining} onPick={join} suggest={suggest} busy={joining} disabled={Boolean(joining)} />
              <NameField value={name} onChange={pickName} />
            </div>
          )}
        </div>
      )}

      <a className="learn-promo" href="#/learn">
        <span className="learn-promo-icon"><IconGrad /></span>
        <span className="learn-promo-text">
          <b>Жест тилин үйрөнүү</b>
          <small>1200+ жест темалар боюнча: аватар көрсөтөт, сиз кайталайсыз — камера текшерет. Тест менен өзүңүздү сынаңыз.</small>
        </span>
        <span className="learn-promo-go"><IconArrow /></span>
      </a>

      {rooms.length > 0 && (
        <section className="recent" aria-label="Акыркы бөлмөлөр">
          <h2 className="card-title">Акыркы бөлмөлөр</h2>
          <div className="recent-list">
            {rooms.map((r) => {
              const RoleIcon = r.role === "speaker" ? IconMic : IconHand;
              return (
                <div key={r.code} className="recent-item">
                  <button className="recent-main" onClick={() => navigate(roomHash(r.code))}>
                    <span className={`rm-avatar ${r.role}`}><RoleIcon /></span>
                    <span className="recent-text">
                      <b className="recent-code">{r.code.slice(0, 3)} {r.code.slice(3)}</b>
                      <small>{ROLE_LABEL[r.role]}{r.partner ? ` · ${r.partner} менен` : ""} · {relTime(r.at)}</small>
                    </span>
                    <IconArrow className="recent-arrow" />
                  </button>
                  <button className="rm-iconbtn sm" onClick={() => forget(r.code)} aria-label={`${r.code} бөлмөсүн тизмеден өчүрүү`}><IconX /></button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="how">
        <div className="how-step"><span className="how-n">1</span><div><b>Бөлмө ачыңыз</b><small>Ролуңузду тандаңыз — код жана QR чыгат.</small></div></div>
        <div className="how-step"><span className="how-n">2</span><div><b>Экинчи адам кирет</b><small>Телефонунан код же QR менен — каттоо жок.</small></div></div>
        <div className="how-step"><span className="how-n">3</span><div><b>Сүйлөшүңүз</b><small>Үн ↔ жест: текст, 3D аватар, үн. Кийин ошол эле код менен улантса болот.</small></div></div>
      </section>

      <p className="home-foot muted"><IconPhone style={{ width: 14, verticalAlign: -2 }} /> Телефондо Chrome же Safari. Даяр сүйлөмдөр интернетсиз да, AI'сыз дароо иштейт.</p>
    </div>
  );
}

function NameField(props: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="name-field">
      <span>Атыңыз <span className="muted">(каалоо боюнча)</span></span>
      <input className="input" value={props.value} onChange={(e) => props.onChange(e.target.value)} placeholder="Мисалы: Айгүл" maxLength={32} autoComplete="given-name" aria-label="Атыңыз" />
    </label>
  );
}

function relTime(t: number): string {
  const d = Date.now() - t;
  const m = Math.round(d / 60000);
  if (m < 1) return "азыр эле";
  if (m < 60) return `${m} мүн. мурун`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} с. мурун`;
  const days = Math.round(h / 24);
  if (days === 1) return "кечээ";
  if (days < 7) return `${days} күн мурун`;
  return new Date(t).toLocaleDateString("ky-KG", { day: "numeric", month: "short" });
}
