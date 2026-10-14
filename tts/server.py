"""Kyrgyz TTS microservice (facebook/mms-tts-kir). POST /tts {"text": "..."} -> audio/wav."""
import io, json, os, re, sys, time, wave, threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = "facebook/mms-tts-kir"
# Docker'де TTS_HOST=0.0.0.0 (контейнерлер ортосунда); демейки — ушул компьютер гана.
HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8790"))
MAX_CHARS = 1500
CACHE_SIZE = 64

_lock = threading.Lock()
_state = {}
_cache = OrderedDict()


def _load():
    if "model" not in _state:
        import torch
        from transformers import VitsModel, AutoTokenizer
        torch.set_num_threads(max(1, (torch.get_num_threads())))
        _state["tok"] = AutoTokenizer.from_pretrained(MODEL_ID)
        _state["model"] = VitsModel.from_pretrained(MODEL_ID).eval()
        _state["vocab"] = set(_state["tok"].get_vocab().keys())
    return _state


def normalize(text, vocab):
    text = text.lower().replace("ё", "е")
    text = re.sub(r"[\u2018\u2019`´]", "'", text)
    text = re.sub(r"[-–—]", " ", text)
    out = "".join(c for c in text if c in vocab or c.isspace())
    return re.sub(r"\s+", " ", out).strip()


def split_sentences(text, limit=200):
    parts = [p.strip() for p in re.split(r"(?<=[.!?…;:])\s+|\n+", text) if p.strip()]
    chunks = []
    for p in parts:
        while len(p) > limit:
            cut = p.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            chunks.append(p[:cut]); p = p[cut:].strip()
        if p:
            chunks.append(p)
    return chunks


def synth(text):
    import numpy as np, torch
    st = _load()
    sr = st["model"].config.sampling_rate
    audio = []
    gap = np.zeros(int(sr * 0.25), dtype=np.float32)
    for sent in split_sentences(text):
        norm = normalize(sent, st["vocab"])
        if not norm:
            continue
        inputs = st["tok"](norm, return_tensors="pt")
        with torch.no_grad():
            wav = st["model"](**inputs).waveform[0].numpy()
        audio += [wav.astype(np.float32), gap]
    if not audio:
        return None
    a = np.clip(np.concatenate(audio[:-1]), -1, 1)
    pcm = (a * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class H(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if re.match(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$", origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send(200, {"ok": True, "model": MODEL_ID, "loaded": "model" in _state})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/tts":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            text = str(json.loads(self.rfile.read(n) or b"{}").get("text", "")).strip()
        except Exception:
            return self._send(400, {"error": "bad json"})
        if not text:
            return self._send(400, {"error": "empty text"})
        text = text[:MAX_CHARS]
        try:
            with _lock:
                if text in _cache:
                    _cache.move_to_end(text); data = _cache[text]
                else:
                    data = synth(text)
                    if data:
                        _cache[text] = data
                        while len(_cache) > CACHE_SIZE:
                            _cache.popitem(last=False)
            if not data:
                return self._send(422, {"error": "no speakable text"})
            self._send(200, data, "audio/wav")
        except Exception as e:
            self._send(500, {"error": str(e)})

    def log_message(self, fmt, *a):
        sys.stderr.write("[tts] " + fmt % a + "\n")


if __name__ == "__main__":
    if "--preload" in sys.argv:
        _load()
    print(f"Kyrgyz TTS on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
