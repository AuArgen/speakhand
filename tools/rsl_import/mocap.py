"""Python port of the app's live tracker (src/vision/tracker.ts + src/vision/handedness.ts).

The output MocapFrame must be identical in convention to what the browser produces:
  * MediaPipe world (x right, y down, z away from camera) -> three.js (x, -y, -z),
    so +x = the signer's LEFT side (video is not mirrored).
  * pose = 33 pose *world* landmarks, hands = 21 hand *world* landmarks (relative to the hand centre).
  * hands are keyed by the signer's ANATOMICAL hand: nearest pose wrist (15 = left, 16 = right),
    falling back to the (un-mirrored) MediaPipe label, then to the image x position.
  * face = the same 15 blendshape names as FACE_BLENDSHAPES in tracker.ts.
Keep this file in sync with tracker.ts / handedness.ts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "public" / "models"

FACE_BLENDSHAPES = [
    "browInnerUp", "browDownLeft", "browDownRight", "browOuterUpLeft", "browOuterUpRight",
    "eyeBlinkLeft", "eyeBlinkRight", "eyeSquintLeft", "eyeSquintRight", "jawOpen",
    "mouthSmileLeft", "mouthSmileRight", "mouthPucker", "mouthFunnel", "cheekPuff",
]
FACE_SET = set(FACE_BLENDSHAPES)

# ---------------------------------------------------------------------------------------------
# handedness.ts
# ---------------------------------------------------------------------------------------------
MAX_WRIST_DIST = 0.25
AMBIGUOUS = 0.02


def _label_side(label, mirrored: bool):
    if label not in ("Left", "Right"):
        return None
    l = "left" if label == "Left" else "right"
    if mirrored:
        return l
    return "right" if l == "left" else "left"


def _position_side(x: float, mirrored: bool) -> str:
    return "left" if ((x >= 0.5) != mirrored) else "right"


def assign_hands(wrists, labels, pose, aspect: float = 4 / 3, mirrored: bool = False):
    """wrists: list of (x, y); labels: list of str|None; pose: list of (x, y, visibility) or None.
    Returns (sides, method) exactly like assignHands() in handedness.ts."""
    n = len(wrists)
    sides = [None] * n
    method = [None] * n
    if not n:
        return sides, method

    def dist(a, b):
        return math.hypot((a[0] - b[0]) * aspect, a[1] - b[1])

    lw = pose[15] if pose is not None and len(pose) > 16 else None
    rw = pose[16] if pose is not None and len(pose) > 16 else None

    def ok(p):
        if p is None:
            return False
        v = p[2] if len(p) > 2 and p[2] is not None else 1.0
        return v >= 0.2

    if ok(lw) and ok(rw):
        dL = [dist(w, lw) for w in wrists]
        dR = [dist(w, rw) for w in wrists]
        if n == 1:
            near = min(dL[0], dR[0])
            if near < MAX_WRIST_DIST and abs(dL[0] - dR[0]) > AMBIGUOUS:
                sides[0] = "left" if dL[0] < dR[0] else "right"
                method[0] = "wrist"
                return sides, method
        else:
            a = dL[0] + dR[1]
            b = dR[0] + dL[1]
            worst = min(max(dL[0], dR[1]), max(dR[0], dL[1]))
            if abs(a - b) > AMBIGUOUS and worst < MAX_WRIST_DIST * 1.5:
                first = "left" if a < b else "right"
                sides[0] = first
                sides[1] = "right" if first == "left" else "left"
                method[0] = method[1] = "wrist"
                for i in range(2, n):
                    sides[i] = "left" if dL[i] < dR[i] else "right"
                    method[i] = "wrist"
                return sides, method

    for i in range(n):
        s = _label_side(labels[i], mirrored)
        sides[i] = s if s is not None else _position_side(wrists[i][0], mirrored)
        method[i] = "label" if s is not None else "position"
    if n >= 2 and sides[0] == sides[1]:
        left_is_first = (wrists[0][0] > wrists[1][0]) != mirrored
        sides[0] = "left" if left_is_first else "right"
        sides[1] = "right" if left_is_first else "left"
        method[0] = method[1] = "position"
    return sides, method


# ---------------------------------------------------------------------------------------------
# tracker.ts
# ---------------------------------------------------------------------------------------------
def r4(v: float) -> float:
    # JS Math.round(v*1e4)/1e4 (round half up, towards +inf)
    return math.floor(v * 1e4 + 0.5) / 1e4


def to_avatar(x: float, y: float, z: float):
    return [r4(x), r4(-y), r4(-z)]


def pick_blend(names, scores, ndigits: int = 3):
    out = {}
    for n, s in zip(names, scores):
        if n in FACE_SET:
            out[n] = math.floor(float(s) * 10 ** ndigits + 0.5) / 10 ** ndigits
    return out


@dataclass
class RawFrame:
    """Everything the tracker needs from one video frame (MediaPipe results in plain arrays)."""
    pose_world: np.ndarray | None  # 33x3
    pose_img: np.ndarray | None  # 33x4 (x, y, z, visibility)
    hand_world: list  # list of 21x3
    hand_img: list  # list of 21x3
    hand_label: list  # list of "Left"/"Right"/None
    hand_score: list
    blend: dict | None  # name -> score (all 52)


def frame_from_raw(raw: RawFrame, t_ms: float, aspect: float, face_enabled: bool = True):
    """RawFrame -> MocapFrame dict (+ diagnostics), exactly like Tracker.detect()."""
    left = right = None
    left_img = right_img = None
    hm = {}
    n = min(len(raw.hand_img), len(raw.hand_world))
    if n:
        pose = None
        if raw.pose_img is not None:
            pose = [(float(p[0]), float(p[1]), float(p[3])) for p in raw.pose_img]
        sides, method = assign_hands(
            wrists=[(float(h[0][0]), float(h[0][1])) for h in raw.hand_img[:n]],
            labels=raw.hand_label[:n],
            pose=pose,
            aspect=aspect,
            mirrored=False,
        )
        for i in range(n):
            world = [to_avatar(*map(float, p)) for p in raw.hand_world[i]]
            if sides[i] == "left" and left is None:
                left, left_img, hm["left"] = world, raw.hand_img[i], method[i]
            elif sides[i] == "right" and right is None:
                right, right_img, hm["right"] = world, raw.hand_img[i], method[i]
    face = None
    if face_enabled and raw.blend is not None:
        face = pick_blend(list(raw.blend.keys()), list(raw.blend.values()))
    frame = {
        "t": t_ms,
        "pose": [to_avatar(*map(float, p)) for p in raw.pose_world] if raw.pose_world is not None else None,
        "leftHand": left,
        "rightHand": right,
        "face": face,
    }
    return frame, {"left_img": left_img, "right_img": right_img, "method": hm}


# ---------------------------------------------------------------------------------------------
# MediaPipe Tasks (same models + options as Tracker.create, VIDEO mode)
# ---------------------------------------------------------------------------------------------
class PyTracker:
    def __init__(self, pose_model: str = "full", face: bool = True):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python import vision as V

        self.mp = mp
        RM = V.RunningMode.VIDEO

        def base(name):
            # model_asset_buffer avoids path issues with non-ASCII / long Windows paths
            return BaseOptions(model_asset_buffer=(MODELS / name).read_bytes())

        self.hand = V.HandLandmarker.create_from_options(V.HandLandmarkerOptions(
            base_options=base("hand_landmarker.task"), running_mode=RM, num_hands=2,
            min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5, min_tracking_confidence=0.5))
        self.pose = V.PoseLandmarker.create_from_options(V.PoseLandmarkerOptions(
            base_options=base(f"pose_landmarker_{pose_model}.task"), running_mode=RM, num_poses=1,
            min_pose_detection_confidence=0.5, min_pose_presence_confidence=0.5, min_tracking_confidence=0.5,
            output_segmentation_masks=False))
        self.face = None
        if face:
            self.face = V.FaceLandmarker.create_from_options(V.FaceLandmarkerOptions(
                base_options=base("face_landmarker.task"), running_mode=RM, num_faces=1,
                output_face_blendshapes=True, output_facial_transformation_matrixes=False))
        self.last_ts = -1

    def process(self, rgb: np.ndarray, ts_ms: int, do_face: bool = True) -> RawFrame:
        ts = ts_ms if ts_ms > self.last_ts else self.last_ts + 1
        self.last_ts = ts
        img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        pr = self.pose.detect_for_video(img, ts)
        hr = self.hand.detect_for_video(img, ts)
        blend = None
        if self.face is not None and do_face:
            fr = self.face.detect_for_video(img, ts)
            if fr.face_blendshapes:
                blend = {c.category_name: float(c.score) for c in fr.face_blendshapes[0]}
        pw = pi = None
        if pr.pose_world_landmarks:
            pw = np.array([[l.x, l.y, l.z] for l in pr.pose_world_landmarks[0]], np.float32)
        if pr.pose_landmarks:
            pi = np.array([[l.x, l.y, l.z, l.visibility if l.visibility is not None else 1.0]
                           for l in pr.pose_landmarks[0]], np.float32)
        n = min(len(hr.hand_landmarks or []), len(hr.hand_world_landmarks or []))
        hw, hi, hl, hs = [], [], [], []
        for i in range(n):
            hw.append(np.array([[l.x, l.y, l.z] for l in hr.hand_world_landmarks[i]], np.float32))
            hi.append(np.array([[l.x, l.y, l.z] for l in hr.hand_landmarks[i]], np.float32))
            cat = hr.handedness[i][0] if hr.handedness and i < len(hr.handedness) and hr.handedness[i] else None
            hl.append(cat.category_name if cat else None)
            hs.append(float(cat.score) if cat else 0.0)
        return RawFrame(pw, pi, hw, hi, hl, hs, blend)

    def close(self):
        self.hand.close()
        self.pose.close()
        if self.face is not None:
            self.face.close()
