"""Step 0: list the playlist and download every lesson as 720p video-only mp4 (no ffmpeg needed)
into cache/videos/lNN.mp4. YouTube sometimes answers 403 — just run again, finished files are skipped.

usage: uv run python download.py
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
PLAYLIST = "https://www.youtube.com/playlist?list=PL_VzOPUOoGKQQ7hyco7uz5apagoF99raf"


def main():
    (CACHE / "videos").mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    pl = CACHE / "playlist.txt"
    if not pl.exists():
        subprocess.run(["uvx", "yt-dlp", "--flat-playlist", "--print-to-file",
                        "%(playlist_index)s|%(id)s|%(duration)s|%(title)s", str(pl), PLAYLIST],
                       check=True, env=env, cwd=CACHE)
    for line in pl.read_text(encoding="utf-8").splitlines():
        idx, vid, _dur, _title = line.split("|", 3)
        out = CACHE / "videos" / f"l{int(idx):02d}.mp4"
        for _ in range(3):
            if out.exists():
                break
            subprocess.run(["uvx", "yt-dlp", "-q", "--no-warnings", "-f", "136/bv*[height<=720][ext=mp4]",
                            "-o", str(out), f"https://www.youtube.com/watch?v={vid}"], env=env)
        print(out.name, "ok" if out.exists() else "FAILED")


if __name__ == "__main__":
    main()
