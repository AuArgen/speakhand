import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { IconBook, IconHand, IconMic, IconMoon, IconRecord, IconSun, Logo } from "./components/icons";
import { IconChevron, IconHome, IconTools, IconUsers } from "./components/room/roomIcons";
import { IconGrad } from "./components/learn/learnIcons";
import { seedIfEmpty } from "./data/store";
import { syncLibrary, type LibraryProgress } from "./data/library";
import { DEMO_SIGNS } from "./avatar/seeds";
import { navigate, useHashRoute, type ToolId } from "./hooks/useHashRoute";
import { getHealth, type ClaudeModel, type Health } from "./lib/api";
import { useStored } from "./lib/settings";
import { HomePage } from "./pages/HomePage";
import { RoomPage } from "./pages/RoomPage";

// Куралдар беттери (3D, камера) өзүнчө файлдарда — башкы бет жана бөлмө тез ачылат.
const TranslatePage = lazy(() => import("./pages/TranslatePage").then((m) => ({ default: m.TranslatePage })));
const RecognizePage = lazy(() => import("./pages/RecognizePage").then((m) => ({ default: m.RecognizePage })));
const StudioPage = lazy(() => import("./pages/StudioPage").then((m) => ({ default: m.StudioPage })));
const DictionaryPage = lazy(() => import("./pages/DictionaryPage").then((m) => ({ default: m.DictionaryPage })));
const LearnPage = lazy(() => import("./pages/LearnPage").then((m) => ({ default: m.LearnPage })));


const TOOLS: { id: ToolId; label: string; hint: string; icon: typeof IconMic }[] = [
  { id: "translate", label: "Үн → Жест", hint: "Сүйлөңүз — аватар жест менен көрсөтөт", icon: IconMic },
  { id: "recognize", label: "Жест → Үн", hint: "Жест көрсөтүңүз — текст жана үн чыгат", icon: IconHand },
  { id: "studio", label: "Студия", hint: "Жесттерди жаздыруу (motion capture)", icon: IconRecord },
  { id: "dictionary", label: "Сөздүк", hint: "Бардык жесттер, издөө, экспорт", icon: IconBook },
];

const MODELS: { id: ClaudeModel; label: string; hint: string }[] = [
  { id: "sonnet", label: "Sonnet", hint: "тең салмактуу (сунушталат)" },
  { id: "haiku", label: "Haiku", hint: "эң арзан" },
  { id: "opus", label: "Opus", hint: "эң так, жайыраак" },
];

export function App() {
  const route = useHashRoute();
  const [studioGloss, setStudioGloss] = useState<string | undefined>();
  const [theme, setTheme] = useStored<"dark" | "light">("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const [model, setModel] = useStored<ClaudeModel>("model", "sonnet");
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  const [toast, setToast] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryProgress | null>(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    // Алгач демо жесттер, анан видео китепкана (демолорду чыныгы жесттер менен алмаштырат).
    seedIfEmpty(DEMO_SIGNS)
      .then(() => syncLibrary(setLibrary))
      .then((n) => {
        setLibrary(null);
        if (n) showToast(`Видео китепканадан ${n} чыныгы жест кошулду`);
      })
      .catch((e) => {
        setLibrary(null);
        console.warn("Жест китепканасы жүктөлгөн жок:", e);
      });
    getHealth().then(setHealth);
  }, []);

  useEffect(() => { scrollTo({ top: 0 }); }, [route]);
  // Бөлмөгө киргенде кызматтардын абалын жаңыртабыз (TTS кийин күйгүзүлүшү мүмкүн)
  useEffect(() => { if (route.kind === "room") getHealth().then((h) => h && setHealth(h)); }, [route]);

  const go = useCallback((t: ToolId) => navigate(`/${t}`), []);
  const showToast = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((x) => (x === m ? null : x)), 3200);
  }, []);

  const claudeReady = Boolean(health?.claude);
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  if (route.kind === "room") {
    return (
      <>
        <ErrorBoundary key={route.code}>
          <RoomPage key={route.code} code={route.code} theme={theme} setTheme={setTheme} model={model} claudeReady={claudeReady} ttsService={health?.tts ?? true} toast={showToast} />
        </ErrorBoundary>
        {toast && <div className="toast" role="status">{toast}</div>}
      </>
    );
  }

  if (route.kind === "home" || route.kind === "learn") {
    const learn = route.kind === "learn";
    return (
      <div className={`app home-app ${learn ? "learn-app" : ""}`}>
        <header className="topbar slim">
          <a className="brand" href={learn ? "#/learn" : "#/"} aria-label={learn ? "Үйрөнүү — темалар" : "Сүйлө — башкы бет"}>
            <Logo className="brand-mark" />
            <div>
              Сүйлө
              <small>{learn ? "Жест тилин үйрөнүү" : "Кыргыз жест тили котормочу"}</small>
            </div>
          </a>
          <div className="topbar-right">
            {library && (
              <span className="chip" title="Видеосабактардан тартылган жесттер бир жолу жүктөлөт">
                <span className="spinner" style={{ width: 12, height: 12 }} /> Жесттер {library.done}/{library.total}
              </span>
            )}
            <ToolsMenu />
            <button className="btn btn-sm btn-icon btn-ghost" onClick={toggleTheme} aria-label="Теманы алмаштыруу">
              {theme === "dark" ? <IconSun /> : <IconMoon />}
            </button>
          </div>
        </header>
        <main className={`main ${learn ? "learn-main" : ""}`}>
          {learn ? (
            <ErrorBoundary>
              <Suspense fallback={<div className="empty"><span className="spinner" /></div>}>
                <LearnPage path={route.path} theme={theme} />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <HomePage />
          )}
        </main>
        {toast && <div className="toast" role="status">{toast}</div>}
      </div>
    );
  }

  const tab = route.tool;
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Сүйлө — башкы бет">
          <Logo className="brand-mark" />
          <div>
            Сүйлө
            <small>Куралдар</small>
          </div>
        </a>
        <nav className="tabs" role="tablist" aria-label="Куралдар">
          {TOOLS.map(({ id, label, icon: I }) => (
            <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => go(id)}>
              <I /> <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <button className="btn btn-sm" onClick={() => navigate("/")} title="Сүйлөшүү бөлмөсүнө"><IconUsers /> <span className="hide-sm">Бөлмө</span></button>
          {library && (
            <span className="chip" title="Видеосабактардан тартылган жесттер бир жолу жүктөлөт">
              <span className="spinner" style={{ width: 12, height: 12 }} /> Жест китепканасы {library.done}/{library.total}
            </span>
          )}
          <span
            className={`chip hide-sm ${health === undefined ? "" : claudeReady ? "ok" : "bad"}`}
            title={health?.claude ? `Claude Code ${health.claude}` : "Claude CLI табылган жок — жөнөкөй эрежелер колдонулат"}
          >
            <span className="dot" /> Claude
          </span>
          <select className="select hide-sm" style={{ height: 34, fontSize: 13, fontWeight: 700 }} value={model} onChange={(e) => setModel(e.target.value as ClaudeModel)} aria-label="Claude модели" title={MODELS.find((m) => m.id === model)?.hint} disabled={!claudeReady}>
            {MODELS.map((m) => <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>)}
          </select>
          <span className={`chip hide-sm ${health?.tts ? "ok" : ""}`} title={health?.tts ? "Кыргызча MMS-TTS иштеп жатат" : "Кыргызча TTS өчүк — браузердин үнү колдонулат"}>
            <span className="dot" /> Кыргызча үн
          </span>
          <button className="btn btn-sm btn-icon btn-ghost" onClick={toggleTheme} aria-label="Теманы алмаштыруу">
            {theme === "dark" ? <IconSun /> : <IconMoon />}
          </button>
        </div>
      </header>

      <main className="main">
        <Suspense fallback={<div className="empty"><span className="spinner" /></div>}>
        {tab === "translate" && <TranslatePage theme={theme} model={model} claudeReady={claudeReady} />}
        {tab === "recognize" && <RecognizePage model={model} claudeReady={claudeReady} goStudio={() => go("studio")} />}
        {tab === "studio" && <StudioPage key={studioGloss} theme={theme} initialGloss={studioGloss} toast={showToast} />}
        {tab === "dictionary" && (
          <DictionaryPage theme={theme} toast={showToast} openStudio={(g) => { setStudioGloss(g); go("studio"); }} />
        )}
        </Suspense>
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

/** «Куралдар» менюсу — эски куралдар экинчи даражада. */
function ToolsMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <div className="menu" ref={box}>
      <button className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <IconTools /> <span>Куралдар</span> <IconChevron style={{ width: 14, transform: open ? "rotate(-90deg)" : "rotate(90deg)" }} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); navigate("/learn"); }}>
            <span className="menu-ic"><IconGrad /></span>
            <span><b>Үйрөнүү</b><small>Жест тилин үйрөнүү жана өзүңүздү текшерүү</small></span>
          </button>
          {TOOLS.map(({ id, label, hint, icon: I }) => (
            <button key={id} role="menuitem" className="menu-item" onClick={() => { setOpen(false); navigate(`/${id}`); }}>
              <span className="menu-ic"><I /></span>
              <span><b>{label}</b><small>{hint}</small></span>
            </button>
          ))}
          <div className="menu-sep" />
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); navigate("/"); }}>
            <span className="menu-ic"><IconHome /></span>
            <span><b>Башкы бет</b><small>Сүйлөшүү бөлмөсү</small></span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Күтүлбөгөн ката бөлмөнү бош калтырбасын: кабар + кайра жүктөө. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Бөлмөдө ката:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="room gate">
        <div className="gate-body" style={{ marginTop: 40 }}>
          <div className="notice error"><span>Күтүлбөгөн ката: {this.state.error.message}</span></div>
          <div className="row">
            <button className="btn btn-primary" onClick={() => location.reload()}>Кайра жүктөө</button>
            <button className="btn" onClick={() => { location.hash = "#/"; this.setState({ error: null }); }}>Башкы бетке</button>
          </div>
        </div>
      </div>
    );
  }
}
