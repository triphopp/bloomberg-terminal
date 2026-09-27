"""Image bytes → Token list, on this machine (no slip leaves it).

Two OCR backends, same Token output; the first one installed wins:

    rapidocr   PP-OCRv5 mobile det + Thai rec on ONNX Runtime. ~1.5 s per slip
               on CPU, model load ~7 s; reads Thai marks and case exactly.
               Needs `onnxruntime` (models are fetched once into rapidocr/models).
    easyocr    CRAFT + CRNN on torch, Thai + English. 12–25 s per slip, load
               ~30 s; lowercases Latin and drops Thai marks. Fallback only.

Measured 2026-09-26 on the COST sample: 99 % of the time is the neural nets
(detect ~50 %, recognise ~50 % on rapidocr); parsing is ~30 ms. A C/Rust
parser would save nothing — the backend choice is the whole difference.

Both run in their own spawned process. In the backend process neither can
load on Windows: torch fails with WinError 1114 (c10.dll) and onnxruntime
segfaults, once the backend's other native libraries are in. So the parent
must never import either — `find_spec` only looks. The worker stays up, so a
model loads once.
"""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from importlib.util import find_spec
import io
import multiprocessing
import threading

from .layout import Token

MAX_SIDE = 2400      # phone screenshots are ~1000×2000; bigger only costs time
MIN_WIDTH = 900      # small crops are upscaled — Thai marks vanish below this
TIMEOUT_S = 240


def _pick_backend() -> str:
    if find_spec("rapidocr") and find_spec("onnxruntime"):
        return "rapidocr:PP-OCRv5-th"
    return "easyocr:th+en"


BACKEND = _pick_backend()

_engine = None          # worker process only
_pool: ProcessPoolExecutor | None = None
_loaded = False         # parent: the worker has finished one read
_lock = threading.Lock()


# ── worker side ─────────────────────────────────────────────────────────────

def _get_engine(backend: str):
    global _engine
    if _engine is None:
        if backend.startswith("rapidocr"):
            from rapidocr import RapidOCR
            from rapidocr.utils.typings import LangRec, ModelType, OCRVersion
            _engine = RapidOCR(params={
                "Det.ocr_version": OCRVersion.PPOCRV5, "Det.model_type": ModelType.MOBILE,
                "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.MOBILE,
                "Rec.lang_type": LangRec.TH,   # the Thai dict also carries Latin + digits
                "Global.use_cls": False,       # screenshots are never upside down
                "Global.log_level": "error",
            })
        else:
            import easyocr
            try:
                import torch
                gpu = torch.cuda.is_available()
            except Exception:
                gpu = False
            _engine = easyocr.Reader(["th", "en"], gpu=gpu, verbose=False)
    return _engine


def _box(points) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))


def _ocr_in_worker(arr, backend: str) -> list[tuple]:
    """Runs in the worker: → (text, x0, y0, x1, y1, conf) rows."""
    eng = _get_engine(backend)
    if backend.startswith("rapidocr"):
        r = eng(arr)
        if r.boxes is None:
            return []
        return [(str(t), *_box(b), float(s)) for b, t, s in zip(r.boxes, r.txts, r.scores)]
    return [(t, *_box(b), float(c)) for b, t, c in eng.readtext(arr)]


# ── parent side ─────────────────────────────────────────────────────────────

def is_loaded() -> bool:
    return _loaded


def load_image(data: bytes):
    import numpy as np
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    w, h = img.size
    scale = 1.0
    if max(w, h) > MAX_SIDE:
        scale = MAX_SIDE / max(w, h)
    elif w < MIN_WIDTH:
        scale = MIN_WIDTH / w
    if scale != 1.0:
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    return np.array(img)


def _get_pool() -> ProcessPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn"))
    return _pool


def warm() -> None:
    """Start the worker and load the model ahead of the first slip (fire and forget)."""
    import numpy as np
    def done(fut):
        global _loaded
        if fut.exception() is None:
            _loaded = True

    if _loaded:
        return
    with _lock:
        fut = _get_pool().submit(_ocr_in_worker, np.full((64, 64, 3), 255, np.uint8), BACKEND)
    fut.add_done_callback(done)


def read(data: bytes) -> list[Token]:
    """Decode here (a bad file fails fast, as PIL.UnidentifiedImageError); OCR in the worker."""
    global _pool, _loaded
    arr = load_image(data)
    with _lock:  # one slip at a time: one model in RAM, reads queue behind it
        try:
            rows = _get_pool().submit(_ocr_in_worker, arr, BACKEND).result(timeout=TIMEOUT_S)
        except BrokenProcessPool as exc:
            _pool = None
            raise RuntimeError("OCR worker crashed — try again") from exc
    _loaded = True
    return [Token(t.strip(), x0, y0, x1, y1, c) for t, x0, y0, x1, y1, c in rows if t.strip()]
