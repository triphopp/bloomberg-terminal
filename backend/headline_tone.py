"""
Headline tone — POS / NEG / NEU from the words of one title.

One list for every surface that shows a tone: the WATCHLIST tab (each article's
`sentiment`, its POS/NEG filter, NEWS PULSE, STORY cards) and NEWS → ROTATION
(groups and their members). Two lists drifting apart would give one headline two
tones on two screens.

Three sources of words, counted once per word of the title:

1. Market moves (`_MOVE_POS` / `_MOVE_NEG`): fell, plunges, surges, rallies …
   Headlines speak in moves; the financial dictionary below, built from 10-K
   filings, has almost none of them.
2. Loughran–McDonald financial sentiment words (2,355 negative, 354 positive):
   bankruptcy, default, concerns, volatile, layoffs / boost, rebound, strength …
   Taken from the copy bundled in the `pysentiment2` wheel on PyPI (version and
   sha256 pinned in `_LM_WHEEL`), fetched once into `backend/cache/lexicon/` —
   gitignored, never committed: the authors give the lists free for academic
   research and license commercial use separately
   (https://sraf.nd.edu/loughranmcdonald-master-dictionary/). Without the file
   the moves and phrases still work.
3. Phrases (`_PHRASE_*`): raises guidance, cuts target, record high, sell-off …

`_HEADLINE_SKIP` takes out dictionary words that mean something else in a
headline ("breaks above", "jobless claims", "rises sharply", "late afternoon",
"rate cut", "best stocks to buy"). Words are whole words, so "rose" is not
"Rosemont". It reads words, not meaning — context beside price, never a signal.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import threading
import time
import zipfile
from pathlib import Path

log = logging.getLogger(__name__)

# ── 1. Market moves ───────────────────────────────────────────────────────────
_MOVE_POS = frozenset("""
beat beats beating surge surges surged surging soar soars soared soaring rally rallies rallied rallying
jump jumps jumped gain gains gained gaining rise rises rising rose climb climbs climbed climbing
advance advances advanced advancing rebound rebounds rebounded upgrade upgrades upgraded
outperform outperforms outperformed outperforming strong stronger boost boosts boosted tops
buyback buybacks win wins approval approved approves bullish optimism recover recovers recovery recovered
""".split())
_MOVE_NEG = frozenset("""
miss misses missed plunge plunges plunged plummet plummets plummeted plummeting slump slumps slumped
tumble tumbles tumbled fall falls fell drop drops dropped decline declines declined declining slide slides slid
sink sinks sank tank tanks tanked crash crashes crashed downgrade downgrades downgraded
underperform underperforms underperformed underperforming weak weaker weakness suffer suffers
lawsuit lawsuits probe recall recalls layoff layoffs warn warns warning halt halts halted fraud bearish
selloff fear fears slowdown losses
""".split())

# ── 3. Phrases ────────────────────────────────────────────────────────────────
_PHRASE_POS = re.compile(
    r"\b(record high|raises (its |price )?(guidance|target|outlook|forecast)|tops (estimates|expectations)"
    r"|beats? (estimates|expectations))\b", re.I)
_PHRASE_NEG = re.compile(
    r"\b(cuts? (its |price )?(guidance|target|outlook|forecast)|lowers (its |price )?(guidance|target|outlook|forecast)"
    r"|loss widens|sell-off|misses (estimates|expectations))\b", re.I)

# Dictionary words that are something else in a headline.
_HEADLINE_SKIP = frozenset("""
break breaks broke against claims claim sharply late closed closing close closes cut cuts critical verdict
defensive despite best better easy question questions uncovered breaking breakout
""".split())

# ── 2. Loughran–McDonald, from the pinned PyPI wheel ─────────────────────────
_LM_WHEEL = {
    "url": "https://files.pythonhosted.org/packages/d1/7c/596f3028260310d6206b7b88fe7d37fdb367913bfac9195912b27ab3cadb/"
           "pysentiment2-0.1.1-py3-none-any.whl",
    "sha256": "d0ff7a0b702654baeff6a6bec231e56ba4c4c9bc9ad4730856e8ca69335450c7",
    "member": "pysentiment2/static/LM.csv",
}
_LM_FILE = Path(__file__).resolve().parent / "cache" / "lexicon" / "loughran_mcdonald.json"
_LM_RETRY_S = 6 * 3600  # a failed fetch is not tried again for 6 h

_lm: tuple[frozenset, frozenset] | None = None
_lm_lock = threading.Lock()
_lm_failed_at = 0.0


def _parse_lm(csv_text: str) -> dict:
    rows = csv.DictReader(io.StringIO(csv_text))
    pos, neg = set(), set()
    for r in rows:
        w = (r.get("Word") or "").strip().lower()
        if not w.isalpha():
            continue
        if (r.get("Positive") or "0") not in ("0", ""):
            pos.add(w)
        if (r.get("Negative") or "0") not in ("0", ""):
            neg.add(w)
    return {"source": _LM_WHEEL["url"], "sha256": _LM_WHEEL["sha256"],
            "positive": sorted(pos), "negative": sorted(neg)}


def fetch_lm() -> dict:
    """Download the pinned wheel, check its sha256, keep the two word lists."""
    import requests  # observed by upstream_health like every other outbound call

    r = requests.get(_LM_WHEEL["url"], timeout=60)
    r.raise_for_status()
    if hashlib.sha256(r.content).hexdigest() != _LM_WHEEL["sha256"]:
        raise ValueError("pysentiment2 wheel does not match its pinned sha256")
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        data = _parse_lm(z.read(_LM_WHEEL["member"]).decode("utf-8", "replace"))
    _LM_FILE.parent.mkdir(parents=True, exist_ok=True)
    _LM_FILE.write_text(json.dumps(data), encoding="utf-8")
    return data


def _load_lm() -> None:
    global _lm, _lm_failed_at
    try:
        data = (json.loads(_LM_FILE.read_text(encoding="utf-8")) if _LM_FILE.is_file() else fetch_lm())
        _lm = (frozenset(data["positive"]) - _HEADLINE_SKIP, frozenset(data["negative"]) - _HEADLINE_SKIP)
        log.info("headline tone: Loughran-McDonald %d positive / %d negative words",
                 len(_lm[0]), len(_lm[1]))
    except Exception as exc:
        _lm_failed_at = time.time()
        log.warning("headline tone: Loughran-McDonald list unavailable (%s) — moves and phrases only", exc)


def _lm_sets() -> tuple[frozenset, frozenset]:
    """The dictionary words, loaded behind the first call (a cold fetch never holds a request)."""
    if _lm is not None:
        return _lm
    if time.time() - _lm_failed_at > _LM_RETRY_S and _lm_lock.acquire(blocking=False):
        def run():
            try:
                _load_lm()
            finally:
                _lm_lock.release()
        if _LM_FILE.is_file():
            run()  # a local file reads in milliseconds
            if _lm is not None:
                return _lm
        else:
            threading.Thread(target=run, daemon=True, name="lm-lexicon").start()
    return (frozenset(), frozenset())


_WORD = re.compile(r"[a-z]+(?:-[a-z]+)?")


def tone_counts(title: str) -> tuple[int, int]:
    """(positive, negative) words in a title — each word counted once."""
    lm_pos, lm_neg = _lm_sets()
    pos = len(_PHRASE_POS.findall(title))
    neg = len(_PHRASE_NEG.findall(title))
    for w in _WORD.findall(title.lower()):
        if w in _HEADLINE_SKIP:
            continue
        if w in _MOVE_POS or w in lm_pos:
            pos += 1
        elif w in _MOVE_NEG or w in lm_neg:
            neg += 1
    return pos, neg


def tone_of(title: str) -> str:
    pos, neg = tone_counts(title)
    return "POS" if pos > neg else "NEG" if neg > pos else "NEU"
