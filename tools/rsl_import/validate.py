"""Port validation: Python tracker (mocap.py) vs the browser tracker (src/vision/tracker.ts).

  uv run python validate.py py <image.png>...           -> cache/val/<name>.py.json (MocapFrame)
  uv run python validate.py cmp <image.png>...          -> compares with cache/val/<name>.browser.json

The browser side is produced on vision-dev.html?image=<url> (pose "full" + face enabled) by reading
window.__vision.last.frame (see README). Both sides run VIDEO mode on the static image repeated.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def run_py(paths, reps: int = 40):
    import cv2
    from mocap import PyTracker, frame_from_raw
    for p in paths:
        p = Path(p)
        bgr = cv2.imread(str(p))
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        trk = PyTracker(pose_model="full", face=True)
        fr = info = None
        for i in range(reps):
            raw = trk.process(rgb, i * 33)
            fr, info = frame_from_raw(raw, i * 33, bgr.shape[1] / bgr.shape[0])
        trk.close()
        out = p.with_suffix(".py.json")
        out.write_text(json.dumps({"frame": fr, "method": info["method"]}), encoding="utf-8")
        print(p.name, "pose" if fr["pose"] else "-", "L" if fr["leftHand"] else "-", "R" if fr["rightHand"] else "-",
              info["method"])


def arr(x):
    return None if x is None else np.array(x, float)


def cmp(paths):
    for p in paths:
        p = Path(p)
        a = json.loads(p.with_suffix(".py.json").read_text(encoding="utf-8"))["frame"]
        b = json.loads(p.with_suffix(".browser.json").read_text(encoding="utf-8"))
        b = b.get("frame", b)
        print(f"== {p.name}")
        for k in ("pose", "leftHand", "rightHand"):
            A, B = arr(a[k]), arr(b[k])
            if A is None or B is None:
                print(f"  {k:9s} py={'yes' if A is not None else 'null'} browser={'yes' if B is not None else 'null'}")
                continue
            d = np.linalg.norm(A - B, axis=1)
            print(f"  {k:9s} mean |d| = {d.mean() * 1000:6.1f} mm  max = {d.max() * 1000:6.1f} mm"
                  + (f"  wrists L {np.linalg.norm(A[15] - B[15]) * 1000:.1f} R {np.linalg.norm(A[16] - B[16]) * 1000:.1f} mm" if k == "pose" else ""))
        fa, fb = a.get("face") or {}, b.get("face") or {}
        if fa and fb:
            ks = sorted(set(fa) & set(fb))
            d = np.array([abs(fa[k] - fb[k]) for k in ks])
            print(f"  face      {len(ks)} keys, mean |d| = {d.mean():.3f}, max = {d.max():.3f} ({ks[int(d.argmax())]})")
        else:
            print(f"  face      py={bool(fa)} browser={bool(fb)}")


if __name__ == "__main__":
    mode, *paths = sys.argv[1:]
    run_py(paths) if mode == "py" else cmp(paths)
