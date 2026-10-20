"""Dump the cached per-frame tracking of lesson videos (cache/track/lNN.npz) as a "live stream":
MocapFrames exactly as Tracker.detect() would emit them (unsmoothed, video fps), plus the image-space
pose points (x, y, visibility) — for the Node live-replay harness (livereplay.ts).

usage (from tools/rsl_import):  uv run python dumpstream.py [lesson numbers...]
output: cache/stream/lNN.json  {fps, width, height, frames: [{t, pose, leftHand, rightHand, face: null, vis: [...33]}]}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build import load_track, raw_frame  # noqa: E402
from mocap import frame_from_raw  # noqa: E402

OUT = HERE / "cache" / "stream"


def dump(lesson: int) -> None:
    T = load_track(lesson)
    fps = float(T["fps"])
    W, H = int(T["width"]), int(T["height"])
    n = T["pose_world"].shape[0]
    frames = []
    for f in range(n):
        raw = raw_frame(T, f)
        fr, diag = frame_from_raw(raw, round(f * 1000.0 / fps, 2), W / H, face_enabled=False)
        pi = raw.pose_img
        fr["vis"] = [round(float(p[3]), 3) for p in pi] if pi is not None else None
        fr["img"] = {
            "pose": [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in pi] if pi is not None else None,
            "left": [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in diag["left_img"]] if diag["left_img"] is not None else None,
            "right": [[round(float(p[0]), 4), round(float(p[1]), 4)] for p in diag["right_img"]] if diag["right_img"] is not None else None,
        }
        frames.append(fr)
    OUT.mkdir(parents=True, exist_ok=True)
    dst = OUT / f"l{lesson:02d}.json"
    dst.write_text(json.dumps({"fps": fps, "width": W, "height": H, "frames": frames}, separators=(",", ":")), encoding="utf-8")
    print(f"l{lesson:02d}: {n} frames @ {fps:.2f} fps -> {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    lessons = [int(a) for a in sys.argv[1:]] or list(range(1, 29))
    for les in lessons:
        dump(les)
