"""Step 1+2a: caption-based segmentation.

For every lesson video: measure the white caption in the top-right area per frame (min(R,G,B) above a
per-pixel temporal background), find caption intervals with hysteresis, then write
  cache/captions/lNN.json      intervals [{idx, f0, f1, peak, t0, t1, score}]
  cache/captions/lNN_sheetK.png contact sheets of the caption crops (most opaque frame), for reading
  cache/captions/lNN_overview.jpg  16 frames of the video (sanity check of the layout)
The caption texts themselves are read by a human/LLM from the sheets and stored in captions_text.json.

usage: uv run python captions.py [lessons...]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
VIDEOS = CACHE / "videos"
OUT = CACHE / "captions"

# caption search area (fractions of the frame)
CY0, CY1 = 0.0, 0.45
SIG_Y1 = 0.32  # the score only uses the first caption line(s); the crop goes lower for 2-line captions
CX0, CX1 = 0.50, 1.0
DS = 4  # downsample factor for the signal
ON, OFF = 6.0, 1.5  # hysteresis thresholds of the caption score


def whiteness(c: np.ndarray) -> np.ndarray:
    """min(R,G,B), but 0 for skin-like pixels (R clearly above B): a white caption fading over the blue
    background always keeps B >= R, the signer's face/hands do not."""
    m = c.min(axis=2)
    skin = c[..., 2].astype(np.int16) > c[..., 0].astype(np.int16) + 12
    m[skin] = 0
    return m


def is_title(bgr: np.ndarray) -> bool:
    """Title / end cards (and black frames) are nearly uniform; lesson frames have the signer in them."""
    g = cv2.cvtColor(cv2.resize(bgr, (64, 36), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    return float(g.std()) < 15.0


def scan(lesson: int):
    cap = cv2.VideoCapture(str(VIDEOS / f"l{lesson:02d}.mp4"))
    fps = cap.get(cv2.CAP_PROP_FPS)
    W, H = int(cap.get(3)), int(cap.get(4))
    y0, y1, x0, x1 = int(H * CY0), int(H * CY1), int(W * CX0), int(W * CX1)
    sig, title, thumbs = [], [], []
    i = 0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    thumb_at = set(np.linspace(0, max(n - 1, 0), 16).astype(int).tolist())
    while True:
        ok, f = cap.read()
        if not ok:
            break
        m = whiteness(f[y0:y1, x0:x1])
        sig.append(cv2.resize(m, (m.shape[1] // DS, m.shape[0] // DS), interpolation=cv2.INTER_AREA))
        title.append(is_title(f))
        if i in thumb_at:
            thumbs.append((i, cv2.resize(f, (320, 180), interpolation=cv2.INTER_AREA)))
        i += 1
    cap.release()
    return fps, (W, H), np.stack(sig).astype(np.float32), np.array(title), thumbs


def _corr(x: np.ndarray, y: np.ndarray) -> float:
    x = x.ravel() - x.mean()
    y = y.ravel() - y.mean()
    return float((x * y).sum() / (np.sqrt((x * x).sum() * (y * y).sum()) + 1e-6))


def split_dips(a: int, b: int, s, min_len: int = 24, ratio: float = 0.6):
    """Split at a pronounced dip of the caption score (one caption fading out while the next fades in)."""
    if b - a < 2 * min_len:
        return [(a, b)]
    k = np.ones(5) / 5
    ss = np.convolve(s[a:b], k, mode="same")
    best, bm = 1.0, None
    for i in range(min_len, len(ss) - min_len):
        if ss[i] <= ss[i - 1] and ss[i] <= ss[i + 1]:
            lm, rm = ss[:i].max(), ss[i:].max()
            r = ss[i] / max(1e-6, min(lm, rm))
            if r < best:
                best, bm = r, i
    if bm is None or best > ratio:
        return [(a, b)]
    m = a + bm
    return split_dips(a, m, s, min_len, ratio) + split_dips(m, b, s, min_len, ratio)


def split_crossfades(a: int, b: int, s, d, rows, k: int = 20, thr: float = 0.55):
    """Captions sometimes cross-fade into the next one without a gap. Split an interval where the caption
    image changes (low correlation between frames k apart, both well visible)."""
    if b - a < 120:  # < 4 s: normal single caption
        return [(a, b)]
    pk = s[a:b].max()
    best, bt = 1.0, None
    for t in range(a + 5, b - k - 5):
        if s[t] > 0.35 * pk and s[t + k] > 0.35 * pk:
            c = _corr(d[t, :rows], d[t + k, :rows])
            if c < best:
                best, bt = c, t
    if bt is None or best > thr:
        return [(a, b)]
    m = bt + k // 2
    return split_crossfades(a, m, s, d, rows, k, thr) + split_crossfades(m, b, s, d, rows, k, thr)


def detect(sig: np.ndarray, title: np.ndarray):
    normal = ~title
    bg = np.percentile(sig[normal] if normal.any() else sig, 20, axis=0)
    d = np.clip(sig - bg[None] - 30, 0, None)
    rows = int(d.shape[1] * (SIG_Y1 - CY0) / (CY1 - CY0))
    s = d[:, :rows].sum(axis=(1, 2)) / 1000.0 * (16 / DS / DS)
    s[title] = 0
    # a title card can bleed one or two frames (fade); ignore frames adjacent to title frames
    t_d = title.copy()
    for k in range(1, 13):
        t_d[:-k] |= title[k:]
        t_d[k:] |= title[:-k]
    s[t_d] = 0
    ivs = []
    on = False
    st = 0
    peak = 0.0
    for i, v in enumerate(s):
        if not on and v > ON:
            j = i
            # back off to the start of the fade-in (but not past a local minimum)
            lo = ivs[-1][1] if ivs else 0
            while j > lo and s[j - 1] > OFF * 0.66 and s[j - 1] <= s[j] + 0.3:
                j -= 1
            on, st, peak = True, j, v
        elif on:
            peak = max(peak, v)
            if v < max(OFF, 0.2 * peak):
                on = False
                ivs.append((st, i))
    if on:
        ivs.append((st, len(s)))
    # fade-out tails: a short, faint interval glued to the previous one belongs to it
    merged = []
    for a, b in ivs:
        if merged and a - merged[-1][1] <= 3 and (b - a) < 36 and s[a:b].max() < 0.3 * s[merged[-1][0]:merged[-1][1]].max():
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    ivs = []
    split_from = {}
    for a, b in merged:
        parts = [p for a2, b2 in split_dips(a, b, s) for p in split_crossfades(a2, b2, s, d, rows)]
        if len(parts) > 1:
            for p in parts:
                split_from[p] = (a, b)
        ivs.extend(parts)
    # pieces produced by splitting that are only a faint fade remnant go back to their neighbour
    changed = True
    while changed:
        changed = False
        for i, (a, b) in enumerate(ivs):
            mx = s[a:b].max()
            nb = []
            if i > 0 and ivs[i - 1][1] >= a - 3:
                nb.append(i - 1)
            if i + 1 < len(ivs) and ivs[i + 1][0] <= b + 3:
                nb.append(i + 1)
            if b - a < 45 and nb:
                j = max(nb, key=lambda j: s[ivs[j][0]:ivs[j][1]].max())
                if mx < 0.45 * s[ivs[j][0]:ivs[j][1]].max():
                    lo, hi = min(a, ivs[j][0]), max(b, ivs[j][1])
                    ivs[min(i, j)] = (lo, hi)
                    del ivs[max(i, j)]
                    changed = True
                    break
    out = []
    for a, b in ivs:
        if b - a < 12:  # < 0.4 s: flicker / fade remnant
            continue
        seg = s[a:b]
        # most opaque frame = the middle of the plateau (>= 90 % of max)
        hi = np.nonzero(seg >= 0.9 * seg.max())[0]
        pk = a + int(hi[len(hi) // 2])
        out.append({"f0": int(a), "f1": int(b), "peak": int(pk), "score": round(float(seg.max()), 1),
                    **({"split": True} if (a, b) in split_from else {})})
    return out, s, d


def crops(lesson: int, ivs, size):
    """Grab the caption crop (full res, enhanced) at each interval's peak frame."""
    W, H = size
    y0, y1, x0, x1 = int(H * CY0), int(H * CY1), int(W * CX0), int(W * CX1)
    want = {iv["peak"]: k for k, iv in enumerate(ivs)}
    cap = cv2.VideoCapture(str(VIDEOS / f"l{lesson:02d}.mp4"))
    res = {}
    i = 0
    last = max(want) if want else -1
    while i <= last:
        ok, f = cap.read()
        if not ok:
            break
        if i in want:
            res[want[i]] = f[y0:y1, x0:x1].copy()
        i += 1
    cap.release()
    return res


def enhance(c: np.ndarray, bg_full: np.ndarray) -> np.ndarray:
    m = whiteness(c).astype(np.float32)
    d = np.clip((m - bg_full - 15) * 2.2, 0, 255)
    return (255 - d).astype(np.uint8)


def text_bbox(mask: np.ndarray):
    """bbox of the main text mass: column clusters (gap <= 40 px), keep the heaviest one. Drops the
    signer's head outline that sometimes leaks in at the left edge."""
    cols = mask.sum(0)
    xs = np.nonzero(cols)[0]
    if not len(xs):
        return 0, mask.shape[1], 0, 60
    groups, cur = [], [xs[0]]
    for x in xs[1:]:
        if x - cur[-1] > 40:
            groups.append(cur)
            cur = [x]
        else:
            cur.append(x)
    groups.append(cur)
    # drop thin clusters hugging the left edge (head outline); keep everything else
    keep = [g for g in groups if not (g[-1] < mask.shape[1] * 0.12 and cols[g].sum() < 0.25 * cols.sum())] or groups
    g = list(range(keep[0][0], keep[-1][-1] + 1))
    xa, xb = g[0], g[-1] + 1
    # vertical extent from the right part only (the head outline lives in the left quarter)
    xr = max(xa, int(mask.shape[1] * 0.25))
    ys = np.nonzero(mask[:, xr:xb].sum(1))[0] if xb > xr else np.array([])
    if not len(ys):
        ys = np.nonzero(mask[:, xa:xb].sum(1))[0]
    return max(0, xa - 12), min(mask.shape[1], xb + 12), max(0, ys.min() - 6), min(mask.shape[0], ys.max() + 6)


def contact_sheets(lesson: int, ivs, crop_imgs, bg, per_sheet: int = 30):
    paths = []
    for s0 in range(0, len(ivs), per_sheet):
        tiles = []
        for k in range(s0, min(len(ivs), s0 + per_sheet)):
            c = crop_imgs.get(k)
            if c is None:
                continue
            bgf = cv2.resize(bg, (c.shape[1], c.shape[0]), interpolation=cv2.INTER_LINEAR)
            e = enhance(c, bgf)
            # trim to the text bbox (+margin) to keep tiles compact
            xa, xb, ya, yb = text_bbox(e < 140)
            e = e[ya:yb, xa:xb]
            e = cv2.resize(e, (e.shape[1] * 3 // 4, e.shape[0] * 3 // 4), interpolation=cv2.INTER_AREA)
            tile = np.full((e.shape[0] + 6, 640), 255, np.uint8)
            tile[3:3 + e.shape[0], 70:70 + min(e.shape[1], 570)] = e[:, :570]
            cv2.putText(tile, f"{k:02d}", (4, tile.shape[0] // 2 + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, 0, 2)
            cv2.line(tile, (0, tile.shape[0] - 1), (640, tile.shape[0] - 1), 180, 1)
            tiles.append(tile)
        if not tiles:
            continue
        # two columns
        half = (len(tiles) + 1) // 2
        colA, colB = tiles[:half], tiles[half:]
        hA = sum(t.shape[0] for t in colA)
        hB = sum(t.shape[0] for t in colB)
        sheet = np.full((max(hA, hB), 1290), 255, np.uint8)
        y = 0
        for t in colA:
            sheet[y:y + t.shape[0], 0:640] = t
            y += t.shape[0]
        y = 0
        for t in colB:
            sheet[y:y + t.shape[0], 650:1290] = t
            y += t.shape[0]
        sheet[:, 644:646] = 0
        p = OUT / f"l{lesson:02d}_sheet{s0 // per_sheet}.png"
        cv2.imwrite(str(p), sheet)
        paths.append(p)
    return paths


def overview(lesson: int, thumbs):
    if not thumbs:
        return
    rows = []
    for r in range(0, 16, 4):
        row = [t for _, t in thumbs[r:r + 4]]
        while len(row) < 4:
            row.append(np.zeros_like(thumbs[0][1]))
        rows.append(np.hstack(row))
    cv2.imwrite(str(OUT / f"l{lesson:02d}_overview.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 80])


def run(lesson: int):
    fps, size, sig, title, thumbs = scan(lesson)
    ivs, s, _ = detect(sig, title)
    W, H = size
    bg = np.percentile(sig[~title] if (~title).any() else sig, 20, axis=0)
    bg_full = cv2.resize(bg, (int(W * CX1) - int(W * CX0), int(H * CY1) - int(H * CY0)), interpolation=cv2.INTER_LINEAR)
    for k, iv in enumerate(ivs):
        iv["idx"] = k
        iv["t0"] = round(iv["f0"] / fps, 3)
        iv["t1"] = round(iv["f1"] / fps, 3)
    ci = crops(lesson, ivs, size)
    OUT.mkdir(parents=True, exist_ok=True)
    sheets = contact_sheets(lesson, ivs, ci, bg_full)
    overview(lesson, thumbs)
    np.save(OUT / f"l{lesson:02d}_score.npy", s.astype(np.float32))
    (OUT / f"l{lesson:02d}.json").write_text(json.dumps(
        {"lesson": lesson, "fps": fps, "size": size, "frames": int(len(s)), "title_frames": int(title.sum()),
         "intervals": ivs}, ensure_ascii=False, indent=1), encoding="utf-8")
    durs = [iv["f1"] - iv["f0"] for iv in ivs]
    return f"l{lesson:02d}: {len(ivs)} captions, mean {np.mean(durs) / fps if durs else 0:.2f}s, sheets {len(sheets)}"


if __name__ == "__main__":
    from concurrent.futures import ProcessPoolExecutor
    lessons = [int(a) for a in sys.argv[1:]] or sorted(int(p.stem[1:]) for p in VIDEOS.glob("l*.mp4"))
    with ProcessPoolExecutor(max_workers=4) as ex:
        for r in ex.map(run, lessons):
            print(r, flush=True)
