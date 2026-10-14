"""Step 3a: run MediaPipe (pose full + hands + face blendshapes, VIDEO mode) over every frame of each
lesson video and cache the raw results to cache/track/lNN.npz. Clip building (build.py) reads these.

usage: uv run python track.py [lesson numbers...] [--jobs 6] [--force]
"""
from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
VIDEOS = CACHE / "videos"
OUT = CACHE / "track"


def track_video(lesson: int, face_every: int = 1, limit: int | None = None) -> str:
    import cv2
    sys.path.insert(0, str(HERE))
    from mocap import PyTracker

    src = VIDEOS / f"l{lesson:02d}.mp4"
    dst = OUT / f"l{lesson:02d}.npz"
    cap = cv2.VideoCapture(str(src))
    fps = cap.get(cv2.CAP_PROP_FPS)
    n_est = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W, H = int(cap.get(3)), int(cap.get(4))
    trk = PyTracker(pose_model="full", face=True)
    pw, pi, hw, hi, hl, hs, bl = [], [], [], [], [], [], []
    names = None
    t0 = time.time()
    i = 0
    while True:
        ok, bgr = cap.read()
        if not ok or (limit and i >= limit):
            break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        ts = int(round(i * 1000.0 / fps))
        r = trk.process(rgb, ts, do_face=(i % face_every == 0))
        nan33 = np.full((33, 3), np.nan, np.float32)
        pw.append(r.pose_world if r.pose_world is not None else nan33)
        pi.append(r.pose_img if r.pose_img is not None else np.full((33, 4), np.nan, np.float32))
        w2 = np.full((2, 21, 3), np.nan, np.float32)
        i2 = np.full((2, 21, 3), np.nan, np.float32)
        l2 = np.full(2, -1, np.int8)
        s2 = np.zeros(2, np.float32)
        for k in range(min(2, len(r.hand_world))):
            w2[k], i2[k] = r.hand_world[k], r.hand_img[k]
            l2[k] = {"Left": 0, "Right": 1}.get(r.hand_label[k], -1)
            s2[k] = r.hand_score[k]
        hw.append(w2); hi.append(i2); hl.append(l2); hs.append(s2)
        if r.blend is not None:
            if names is None:
                names = list(r.blend.keys())
            bl.append(np.array([r.blend[n] for n in names], np.float32))
        else:
            bl.append(None)
        i += 1
    cap.release()
    trk.close()
    nb = len(names) if names else 52
    blend = np.stack([b if b is not None else np.full(nb, np.nan, np.float32) for b in bl])
    OUT.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        dst, fps=fps, width=W, height=H, pose_world=np.stack(pw), pose_img=np.stack(pi),
        hand_world=np.stack(hw), hand_img=np.stack(hi), hand_label=np.stack(hl), hand_score=np.stack(hs),
        blend=blend, blend_names=np.array(names or []), face_every=face_every)
    dt = time.time() - t0
    return f"l{lesson:02d}: {i} frames ({n_est} est) in {dt:.0f}s = {1000 * dt / max(i, 1):.1f} ms/frame"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("lessons", nargs="*", type=int)
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="debug: only first N frames")
    a = ap.parse_args()
    lessons = a.lessons or sorted(int(p.stem[1:]) for p in VIDEOS.glob("l*.mp4"))
    todo = [l for l in lessons if a.force or not (OUT / f"l{l:02d}.npz").exists()]
    # longest first for better packing
    todo.sort(key=lambda l: -(VIDEOS / f"l{l:02d}.mp4").stat().st_size)
    print(f"tracking {len(todo)} videos with {a.jobs} jobs", flush=True)
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=a.jobs) as ex:
        futs = {ex.submit(track_video, l, 1, a.limit): l for l in todo}
        for f in as_completed(futs):
            try:
                print(f.result(), f"[{time.time() - t0:.0f}s]", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"l{futs[f]:02d}: FAILED {e!r}", flush=True)


if __name__ == "__main__":
    main()
