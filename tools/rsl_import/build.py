"""Steps 1b + 3b + 5: caption intervals + hand activity -> one clip per sign; raw MediaPipe results ->
MocapFrames (via mocap.py, the 1:1 port of the app tracker) -> smoothing / gap filling / resampling ->
public/signs/rsl/manifest.json + lNN.json.

Inputs:  cache/captions/lNN.json, cache/track/lNN.npz, captions_text.json, glosses.json, cache/playlist.txt
usage:   uv run python build.py [lessons...]     (no args = all lessons that have texts)
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from mocap import FACE_BLENDSHAPES, RawFrame, frame_from_raw  # noqa: E402

ROOT = HERE.parents[1]
CACHE = HERE / "cache"
OUT = ROOT / "public" / "signs" / "rsl"
CLIPS = OUT / "clips"
OUT_FPS = 20.0  # 20–25 allowed; 20 keeps the library small

PLAYLIST_URL = "https://www.youtube.com/playlist?list=PL_VzOPUOoGKQQ7hyco7uz5apagoF99raf"
SOURCE = "Русский жестовый язык — видеосабактар (YouTube канал: Енох Иаредович / Голос Истины)"

RAISED_ON, RAISED_OFF = 0.86, 0.90  # highest pose wrist y (image, 0 = top) for "hands up" hysteresis
REST_Y = 0.93  # a wrist lower than this counts as resting (missing hand is fine there)
MAX_GAP = 4  # fill hand/pose dropouts up to this many source frames
MAX_MISSING = 0.40


# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
def load_track(lesson: int):
    z = np.load(CACHE / "track" / f"l{lesson:02d}.npz", allow_pickle=False)
    return {k: z[k] for k in z.files}


def raw_frame(T, f: int) -> RawFrame:
    pw = T["pose_world"][f]
    pi = T["pose_img"][f]
    hw, hi, hl, hs = [], [], [], []
    for k in range(2):
        if not np.isnan(T["hand_img"][f, k, 0, 0]):
            hw.append(T["hand_world"][f, k])
            hi.append(T["hand_img"][f, k])
            lab = int(T["hand_label"][f, k])
            hl.append({0: "Left", 1: "Right"}.get(lab))
            hs.append(float(T["hand_score"][f, k]))
    b = T["blend"][f]
    blend = None
    if len(T["blend_names"]) and not np.isnan(b[0]):
        blend = {str(n): float(v) for n, v in zip(T["blend_names"], b)}
    return RawFrame(
        pose_world=None if np.isnan(pw[0, 0]) else pw,
        pose_img=None if np.isnan(pi[0, 0]) else pi,
        hand_world=hw, hand_img=hi, hand_label=hl, hand_score=hs, blend=blend)


def smooth_runs(x: np.ndarray, ok: np.ndarray, sigma: float = 1.0) -> np.ndarray:
    """Gaussian smoothing along time within runs of valid frames (x: T x ...)."""
    if sigma <= 0:
        return x
    r = int(math.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    out = x.copy()
    T = len(x)
    for t in range(T):
        if not ok[t]:
            continue
        acc = np.zeros_like(x[t])
        wsum = 0.0
        for j in range(-r, r + 1):
            u = t + j
            if 0 <= u < T and ok[u]:
                acc += k[j + r] * x[u]
                wsum += k[j + r]
        out[t] = acc / wsum
    return out


def fill_gaps(x: np.ndarray, ok: np.ndarray, max_gap: int = MAX_GAP):
    """Linear interpolation over interior dropouts of <= max_gap frames."""
    ok = ok.copy()
    x = x.copy()
    T = len(ok)
    t = 0
    while t < T:
        if ok[t]:
            t += 1
            continue
        a = t
        while t < T and not ok[t]:
            t += 1
        b = t  # first ok after the gap (or T)
        if a > 0 and b < T and (b - a) <= max_gap:
            for u in range(a, b):
                w = (u - (a - 1)) / (b - (a - 1))
                x[u] = x[a - 1] * (1 - w) + x[b] * w
                ok[u] = True
    return x, ok


def speed_signal(T) -> np.ndarray:
    """Per-frame motion: wrist speed in the image (+ hand-shape change), smoothed."""
    fps = float(T["fps"])
    w = T["pose_img"][:, [15, 16], :2]
    v = np.linalg.norm(np.diff(w, axis=0), axis=2) * fps
    v = np.nan_to_num(v).max(axis=1)
    hw = T["hand_world"]
    hv = np.nan_to_num(np.linalg.norm(np.diff(hw, axis=0), axis=3).mean(axis=2) * fps).max(axis=1)
    s = np.concatenate([[0.0], v + 2.0 * hv])
    k = np.ones(5) / 5
    return np.convolve(s, k, mode="same")


def raised_signal(T) -> np.ndarray:
    y = T["pose_img"][:, [15, 16], 1]
    m = np.nan_to_num(y, nan=2.0).min(axis=1)
    r = np.zeros(len(m), bool)
    on = False
    for i, v in enumerate(m):
        if not on and v < RAISED_ON:
            on = True
        elif on and v > RAISED_OFF:
            on = False
        r[i] = on
    # close tiny holes / remove blips (< 0.2 s)
    return r


def runs(mask: np.ndarray):
    out = []
    t = 0
    while t < len(mask):
        if mask[t]:
            a = t
            while t < len(mask) and mask[t]:
                t += 1
            out.append((a, t))
        else:
            t += 1
    return out


# ---------------------------------------------------------------------------------------------
# segmentation: caption interval -> sign interval
# ---------------------------------------------------------------------------------------------
def segment(caps: list[dict], T, lesson: int):
    fps = float(T["fps"])
    n = len(T["pose_img"])
    sp = speed_signal(T)
    raised = raised_signal(T)
    # merge raised runs separated by < 0.15 s, drop blips < 0.25 s
    rr = []
    for a, b in runs(raised):
        if rr and a - rr[-1][1] < 0.15 * fps:
            rr[-1] = (rr[-1][0], b)
        else:
            rr.append((a, b))
    rr = [(a, b) for a, b in rr if b - a >= 0.25 * fps]
    S = lambda sec: int(round(sec * fps))  # noqa: E731
    pad = S(0.2)
    res = []
    prev_end = 0
    for k, c in enumerate(caps):
        c0, c1 = c["f0"], c["f1"]
        nxt = caps[k + 1]["f0"] if k + 1 < len(caps) else n
        prv = caps[k - 1]["f1"] if k > 0 else 0
        w0 = max(prev_end, prv - S(0.2), c0 - S(0.6), 0)
        w1 = min(n, c1 + S(1.2), nxt + S(0.9))
        core0, core1 = c0, min(c1 + S(0.8), w1)
        best, bo = None, 0
        for a, b in rr:
            o = min(b, core1) - max(a, core0)
            if o > bo:
                best, bo = (a, b), o
        if best is None or bo < S(0.3):
            res.append({"cap": c, "drop": "no hands raised"})
            continue
        a, b = best
        cont_start = a < w0 + 2  # hands were already up when the window opened: continuous signing
        cont_end = b > w1 - 2
        if lesson == 1:
            # dactyl: the hand stays up; a letter is held while its caption is shown, the change to the
            # next letter happens just after the caption ends
            lo, hi = max(w0, c0 - S(0.2)), min(c0 + S(0.5), c1 - S(0.5))
            s0 = lo + int(np.argmin(sp[lo:hi])) if hi > lo else c0
            s0 = max(s0 - S(0.1), w0)
            # a letter is a held handshape (some have a short movement): keep at most 1.8 s
            e0 = min(c1 + S(0.1), w1, s0 + S(1.8))
        else:
            if cont_start:
                lo, hi = max(w0, c0 - S(0.3)), min(c0 + S(0.4), c1)
                s0 = lo + int(np.argmin(sp[lo:hi])) if hi > lo else c0
            else:
                s0 = max(w0, a - pad)
            if cont_end:
                lo, hi = max(s0 + S(0.6), c1 - S(0.3)), min(w1, c1 + S(0.5))
                e0 = lo + int(np.argmin(sp[lo:hi])) if hi > lo else min(c1, w1)
            else:
                e0 = min(w1, b + pad)
        if e0 - s0 < S(0.5):
            res.append({"cap": c, "drop": "too short"})
            continue
        prev_end = e0
        res.append({"cap": c, "f0": int(s0), "f1": int(e0), "rest_start": not cont_start, "rest_end": not cont_end})
    return res


# ---------------------------------------------------------------------------------------------
# clip extraction
# ---------------------------------------------------------------------------------------------
def r4(v):
    return float(np.floor(v * 1e4 + 0.5) / 1e4)


def extract(T, f0: int, f1: int):
    fps = float(T["fps"])
    aspect = float(T["width"]) / float(T["height"])
    N = f1 - f0
    pose = np.full((N, 33, 3), np.nan)
    hands = {"leftHand": np.full((N, 21, 3), np.nan), "rightHand": np.full((N, 21, 3), np.nan)}
    face = np.full((N, len(FACE_BLENDSHAPES)), np.nan)
    for i in range(N):
        fr, _ = frame_from_raw(raw_frame(T, f0 + i), 0.0, aspect, face_enabled=True)
        if fr["pose"] is not None:
            pose[i] = fr["pose"]
        for side in ("leftHand", "rightHand"):
            if fr[side] is not None:
                hands[side][i] = fr[side]
        if fr["face"]:
            face[i] = [fr["face"].get(nm, 0.0) for nm in FACE_BLENDSHAPES]
    ok_p = ~np.isnan(pose[:, 0, 0])
    ok_f = ~np.isnan(face[:, 0])
    pose, ok_p = fill_gaps(pose, ok_p)
    pose = smooth_runs(pose, ok_p, 1.0)
    face, ok_f = fill_gaps(face, ok_f, 6)
    face = smooth_runs(face, ok_f, 1.0)
    ok_h = {}
    for side in hands:
        ok = ~np.isnan(hands[side][:, 0, 0])
        hands[side], ok = fill_gaps(hands[side], ok)
        hands[side] = smooth_runs(hands[side], ok, 0.8)
        ok_h[side] = ok

    # quality / expected hands
    wy = T["pose_img"][f0:f1, [15, 16], 1]  # 0 = signer's left wrist, 1 = right
    up = {"leftHand": np.nan_to_num(wy[:, 0], nan=2) < REST_Y, "rightHand": np.nan_to_num(wy[:, 1], nan=2) < REST_Y}
    expected = [s for s in hands if ok_h[s].mean() >= 0.25 or up[s].mean() >= 0.25]
    good = ok_p.copy()
    miss = np.zeros(N, bool)
    for s in expected:
        need = up[s] | ok_h[s]
        good &= ok_h[s] | ~up[s]
        miss |= need & ~ok_h[s]
    quality = float(good.mean()) if N else 0.0
    # missing fraction is measured over frames where an expected hand is raised
    anyup = np.zeros(N, bool)
    for s in expected:
        anyup |= up[s]
    missing = float(miss[anyup].mean()) if anyup.any() else 1.0
    if not expected:
        missing = 1.0

    # resample to OUT_FPS
    src_t = np.arange(N) / fps * 1000.0
    dur = src_t[-1]
    nout = int(math.floor(dur / (1000.0 / OUT_FPS))) + 1
    frames = []
    for k in range(nout):
        t = k * 1000.0 / OUT_FPS
        u = t * fps / 1000.0
        i0 = min(int(math.floor(u)), N - 1)
        i1 = min(i0 + 1, N - 1)
        w = u - i0

        def lerp(arr, ok):
            if ok[i0] and ok[i1]:
                return arr[i0] * (1 - w) + arr[i1] * w
            j = i0 if w < 0.5 else i1
            return arr[j] if ok[j] else None

        p = lerp(pose, ok_p)
        fc = lerp(face, ok_f)
        fr = {
            "t": round(t, 1),
            "pose": [[r4(a), r4(b), r4(c)] for a, b, c in p] if p is not None else None,
        }
        for side in ("leftHand", "rightHand"):
            h = lerp(hands[side], ok_h[side])
            fr[side] = [[r4(a), r4(b), r4(c)] for a, b, c in h] if h is not None else None
        fr["face"] = ({nm: round(float(v), 2) for nm, v in zip(FACE_BLENDSHAPES, fc)} if fc is not None else None)
        frames.append(fr)
    return {"kind": "mocap", "fps": OUT_FPS, "frames": frames}, quality, missing, expected


# ---------------------------------------------------------------------------------------------
# compact clip format v2 (decoder: src/data/clipCodec.ts)
# ---------------------------------------------------------------------------------------------
Q_POS = 0.0005  # metres per unit (0.5 mm)
Q_FACE = 100  # blendshape 0..1 -> 0..100
STREAMS = (("pose", "pose"), ("leftHand", "lh"), ("rightHand", "rh"), ("face", "face"))


def encode_clip(clip: dict) -> dict:
    """MocapClip -> format v2: per stream a presence mask ("1"/"0" per frame, omitted when every frame has
    it) and the quantised ints of the present frames, frame-major, delta-coded over time (first present
    frame absolute, then difference to the previous present frame). Frame times are i * 1000 / fps."""
    fr = clip["frames"]
    out = {"v": 2, "fps": clip["fps"], "n": len(fr), "q": Q_POS, "fk": FACE_BLENDSHAPES}
    for key, name in STREAMS:
        rows, mask = [], []
        for f in fr:
            v = f[key]
            mask.append("1" if v is not None else "0")
            if v is None:
                continue
            if key == "face":
                rows.append([int(round(v.get(k, 0.0) * Q_FACE)) for k in FACE_BLENDSHAPES])
            else:
                rows.append([int(round(c / Q_POS)) for p in v for c in p])
        if not rows:
            out[name] = None
            continue
        a = np.array(rows, dtype=np.int64)
        d = a.copy()
        d[1:] -= a[:-1]
        st = {"d": d.ravel().tolist()}
        if "0" in mask:
            st["m"] = "".join(mask)
        out[name] = st
    return out


def write_json_gz(path: Path, obj, indent=None):
    import gzip
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if indent is None else None, indent=indent)
    data = txt.encode("utf-8")
    path.write_bytes(data)
    # mtime=0 -> reproducible bytes (stable ETags)
    with open(str(path) + ".gz", "wb") as fh:
        with gzip.GzipFile(filename="", mode="wb", fileobj=fh, compresslevel=9, mtime=0) as gz:
            gz.write(data)
    return len(data), (Path(str(path) + ".gz")).stat().st_size


# ---------------------------------------------------------------------------------------------
# glosses
# ---------------------------------------------------------------------------------------------
KY_UNITS = {0: "нөл", 1: "бир", 2: "эки", 3: "үч", 4: "төрт", 5: "беш", 6: "алты", 7: "жети", 8: "сегиз", 9: "тогуз"}
KY_TENS = {10: "он", 20: "жыйырма", 30: "отуз", 40: "кырк", 50: "элүү", 60: "алтымыш", 70: "жетимиш", 80: "сексен", 90: "токсон"}


def ky_number(n: int) -> str:
    if n < 10:
        return KY_UNITS[n]
    if n < 100:
        t, u = divmod(n, 10)
        return KY_TENS[t * 10] + ("" if u == 0 else " " + KY_UNITS[u])
    for base, word in ((10 ** 9, "миллиард"), (10 ** 6, "миллион"), (1000, "миң"), (100, "жүз")):
        if n >= base:
            q, r = divmod(n, base)
            head = word if (q == 1 and base in (100, 1000)) else f"{ky_number(q)} {word}"
            return head + ("" if r == 0 else " " + ky_number(r))
    return str(n)


def number_entry(ru: str):
    digits = re.sub(r"[.\s]", "", ru)
    if not digits.isdigit():
        return None
    n = int(digits)
    words = ky_number(n)
    aliases = [words, digits]
    if " " in words:
        aliases.append(words.replace(" ", ""))
    if n < 100:
        aliases += [words + ("ы" if words[-1] not in "аоуыэеиөүю" else "")]  # loose possessive form
    return {"gloss": str(n), "aliases": list(dict.fromkeys(a for a in aliases if a))}


def letter_entry(ru: str):
    t = ru.strip()
    letters = [x for x in re.split(r"[\s,]+", t) if x]
    if not letters or any(len(x) != 1 for x in letters):
        return None
    return {"gloss": "#" + letters[0].upper(), "aliases": [x.lower() for x in letters]}


def base_ru(ru: str) -> str:
    """'Вы (2)' -> 'Вы', 'Пожалуйста (ответ)' -> 'Пожалуйста' (for gloss lookup fallback only)."""
    return re.sub(r"\s*\([^)]*\)\s*$", "", ru).strip()


# ---------------------------------------------------------------------------------------------
def lesson_meta():
    meta = {}
    for line in (CACHE / "playlist.txt").read_text(encoding="utf-8").splitlines():
        idx, vid, dur, title = line.split("|", 3)
        m = re.search(r"Урок\s*\d+\.\s*(.+)$", title)
        meta[int(idx)] = {"videoId": vid, "topic": (m.group(1).strip().rstrip(".") if m else title)}
    return meta


def expand_texts(caps, texts: dict, fps: float):
    """Apply captions_text.json entries to the detected intervals.
    value: "text" | null (skip) | ["A", 24.4, "B"] (split at 24.4 s)."""
    out = []
    for c in caps:
        v = texts.get(str(c["idx"]))
        if v is None or v == "":
            continue
        if v == "+":  # caption continues the previous one (e.g. a 2nd caption line shown later)
            if out and out[-1]["idx"] == c["idx"] - 1 or (out and out[-1].get("merged_to") == c["idx"] - 1):
                out[-1] = {**out[-1], "f1": c["f1"], "merged_to": c["idx"]}
            continue
        if isinstance(v, list):
            parts = []
            cur0 = c["f0"]
            for j in range(0, len(v), 2):
                txt = v[j]
                end = int(round(v[j + 1] * fps)) if j + 1 < len(v) else c["f1"]
                parts.append({**c, "f0": cur0, "f1": end, "text": txt, "sub": j // 2})
                cur0 = end
            out.extend(p for p in parts if p["text"])
        else:
            out.append({**c, "text": v, "sub": 0})
    return out


def build_lesson(lesson: int, texts: dict, glosses: dict, meta: dict, report: dict):
    capj = json.loads((CACHE / "captions" / f"l{lesson:02d}.json").read_text(encoding="utf-8"))
    T = load_track(lesson)
    fps = float(T["fps"])
    CLIPS.mkdir(parents=True, exist_ok=True)
    for old in CLIPS.glob(f"l{lesson:02d}_*.json*"):  # stale clips of this lesson
        old.unlink()
    caps = expand_texts(capj["intervals"], texts, fps)
    segs = segment(caps, T, lesson)
    clips, items = {}, []
    for seq, sg in enumerate(segs):
        c = sg["cap"]
        ru = c["text"]
        cid = f"l{lesson:02d}_{seq:03d}"
        if "drop" in sg:
            report["dropped"].append((cid, ru, sg["drop"]))
            continue
        clip, quality, missing, expected = extract(T, sg["f0"], sg["f1"])
        if missing > MAX_MISSING:
            report["dropped"].append((cid, ru, f"hands missing {missing:.0%}"))
            continue
        if lesson == 1:
            g = letter_entry(ru)
        elif lesson == 2:
            g = number_entry(ru) or glosses.get(ru) or glosses.get(base_ru(ru))
        else:  # "ru@lesson" disambiguates homographs (e.g. "Есть" = eat in lesson 8, = "there is" in 12)
            g = glosses.get(f"{ru}@{lesson}") or glosses.get(ru) or glosses.get(base_ru(ru))
        if not g:
            report["dropped"].append((cid, ru, "no gloss"))
            continue
        clips[cid] = clip
        raw, gz = write_json_gz(CLIPS / f"{cid}.json", encode_clip(clip))
        report["bytes"] += raw
        report["gz"] += gz
        items.append({
            "id": cid, "gloss": g["gloss"], "aliases": g["aliases"], "ru": ru, "lesson": lesson,
            "topic": meta[lesson]["topic"], "videoId": meta[lesson]["videoId"],
            "t0": round(sg["f0"] / fps, 2), "t1": round(sg["f1"] / fps, 2),
            "clip": f"clips/{cid}.json", "frames": len(clip["frames"]), "quality": round(quality, 2),
        })
    report["captions"] += len(caps)
    report["kept"] += len(items)
    return items


def main():
    texts_all = json.loads((HERE / "captions_text.json").read_text(encoding="utf-8"))
    glosses = json.loads((HERE / "glosses.json").read_text(encoding="utf-8")) if (HERE / "glosses.json").exists() else {}
    meta = lesson_meta()
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    lessons = [int(a) for a in args] or sorted(int(k) for k in texts_all)
    man_path = OUT / "manifest.json"
    old = json.loads(man_path.read_text(encoding="utf-8"))["items"] if (man_path.exists() and args) else []
    items = [it for it in old if it["lesson"] not in lessons]
    report = {"captions": 0, "kept": 0, "dropped": [], "bytes": 0, "gz": 0}
    for l in lessons:
        its = build_lesson(l, texts_all[str(l)], glosses, meta, report)
        print(f"l{l:02d}: {len(its)} clips", flush=True)
        items += its
    items.sort(key=lambda it: it["id"])
    man = {"version": 1, "format": 2, "source": SOURCE, "playlist": PLAYLIST_URL, "items": items}
    raw, gz = write_json_gz(man_path, man)
    for legacy in OUT.glob("l[0-9][0-9].json"):  # format-1 lesson files
        legacy.unlink()
    n = max(1, report["kept"])
    print(f"clips: {report['bytes'] / 1e6:.1f} MB json, {report['gz'] / 1e6:.1f} MB gz "
          f"(avg {report['gz'] / n / 1024:.1f} KB gz/clip); manifest {raw / 1024:.0f} KB, {gz / 1024:.0f} KB gz")
    print(f"captions {report['captions']}, kept {report['kept']}, dropped {len(report['dropped'])}")
    for d in report["dropped"]:
        print("  drop", *d)
    (CACHE / "build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    if "--no-templates" not in sys.argv:
        # recognition templates must be recomputed with the app's own features.ts (TypeScript)
        import shutil
        import subprocess
        npx = shutil.which("npx") or shutil.which("npx.cmd")
        if npx:
            subprocess.run([npx, "tsx", str(HERE / "templates.ts")], cwd=ROOT, check=False)
        else:
            print("npx not found: run `npx tsx tools/rsl_import/templates.ts` yourself")


if __name__ == "__main__":
    main()
