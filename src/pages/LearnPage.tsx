// «Үйрөнүү» — жест тилин үйрөнүү жана өзүн текшерүү.
//   #/learn                    — курстун картасы
//   #/learn/<трек>             — тема: прогресс, аракеттер, сөздөр
//   #/learn/<трек>/learn/<i>   — үйрөнүү картасы (+ «Кайталаңыз» камера менен)
//   #/learn/<трек>/quiz        — «Бул кайсы жест?» (камерасыз)
//   #/learn/<трек>/show        — «Көрсөтүңүз» (камера, checkSign)
// Трек: "l<сабак>" (тема), "phrases" (даяр сүйлөмдөр), "review" (каталар), "mine" (жаздырылгандар).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CourseMap } from "../components/learn/CourseMap";
import { buildTracks, indexItems, type LearnItem, type Track } from "../components/learn/course";
import { LearnSession } from "../components/learn/LearnSession";
import { useLearnState } from "../components/learn/progress";
import { Quiz } from "../components/learn/Quiz";
import { TrackHub } from "../components/learn/TrackHub";
import { learnHash, navigate } from "../hooks/useHashRoute";
import { fetchPhrases, type PhraseItem } from "../lib/room";
import { wordLabel } from "../lib/topics";
import { useDictionary } from "../lib/useDictionary";

export function LearnPage(props: { path: string[]; theme: "dark" | "light" }) {
  const { signs, loading } = useDictionary();
  const [phrases, setPhrases] = useState<PhraseItem[]>([]);
  const [phrasesLoading, setPhrasesLoading] = useState(true);
  const st = useLearnState();

  useEffect(() => {
    fetchPhrases().then((p) => { setPhrases(p); setPhrasesLoading(false); });
  }, []);

  const tracks = useMemo(() => buildTracks(signs, phrases), [signs, phrases]);
  const index = useMemo(() => indexItems(tracks), [tracks]);
  const all = useMemo(() => [...index.values()], [index]);
  const byGloss = useMemo(() => new Map(signs.map((s) => [s.gloss, s])), [signs]);

  const labelOf = useCallback((g: string) => {
    const e = byGloss.get(g);
    if (!e) return g.replace(/^#/, "").toLocaleLowerCase("ky-KG");
    return /^#.$/u.test(e.gloss) ? e.gloss.slice(1) : wordLabel(e);
  }, [byGloss]);

  const [trackId, sub, arg] = props.path;

  // Каталар трегi: ачылган учурдагы тизме (кайталап жатканда элементтер тизмеден чыкса да, индекс жылбасын)
  const reviewNow = useMemo(() => {
    const items = Object.entries(st.items)
      .filter(([, p]) => p.miss)
      .sort((a, b) => b[1].t - a[1].t)
      .map(([k]) => index.get(k))
      .filter((x): x is LearnItem => Boolean(x));
    return items.length ? items : null;
  }, [st.items, index]);
  const reviewSnap = useRef<LearnItem[] | null>(null);
  if (trackId !== "review") reviewSnap.current = null;
  else if (!reviewSnap.current && reviewNow) reviewSnap.current = reviewNow;
  const reviewTrack = (items: LearnItem[] | null): Track | null =>
    items ? { id: "review", title: "Каталарды кайталоо", desc: "Тестте ката кеткен жесттер", emoji: "🔁", kind: "signs", core: false, items } : null;

  const track: Track | null | undefined = !trackId
    ? undefined
    : trackId === "review"
      ? reviewTrack(reviewSnap.current ?? reviewNow)
      : tracks.find((t) => t.id === trackId) ?? null;

  const busy = loading || (trackId === "phrases" && phrasesLoading);

  let body;
  if (!trackId) {
    body = <CourseMap tracks={tracks} review={reviewTrack(reviewNow)} loading={loading || phrasesLoading} />;
  } else if (!track) {
    body = busy ? (
      <div className="empty"><span className="spinner" /></div>
    ) : (
      <div className="empty">
        <strong>{trackId === "review" ? "Кайталай турган ката жок 🎉" : "Мындай тема табылган жок"}</strong>
        <button className="btn" style={{ marginTop: 12 }} onClick={() => navigate(learnHash())}>Бардык темалар</button>
      </div>
    );
  } else if (sub === "learn") {
    body = <LearnSession key={track.id} track={track} index={Number(arg) || 0} theme={props.theme} signs={signs} labelOf={labelOf} />;
  } else if (sub === "quiz" || sub === "show") {
    body = <Quiz key={`${track.id}:${sub}`} track={track} mode={sub === "quiz" ? "pick" : "show"} theme={props.theme} signs={signs} all={all} labelOf={labelOf} />;
  } else {
    body = <TrackHub track={track} />;
  }

  return <div className="ln">{body}</div>;
}
