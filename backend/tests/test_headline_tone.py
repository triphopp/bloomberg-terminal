"""Headline tone — moves, phrases, dictionary words, headline exceptions.

No network: the Loughran–McDonald sets are stubbed with a few of their words.
"""

from __future__ import annotations

import io
import zipfile

import pytest

import headline_tone as ht


@pytest.fixture(autouse=True)
def lm(monkeypatch):
    monkeypatch.setattr(ht, "_lm", (
        frozenset({"strength", "attractive", "winner", "despite"}) - ht._HEADLINE_SKIP,
        frozenset({"volatile", "bankruptcy", "concerns", "losing", "breaks", "claims"}) - ht._HEADLINE_SKIP,
    ))


@pytest.mark.parametrize("title,tone", [
    # moves (not in the dictionary)
    ("Why AMD Stock Fell on Thursday", "NEG"),
    ("Valero Q3 Earnings Surge Sixfold", "POS"),
    # dictionary words
    ("Can Midstream Energy Firms Weather a Volatile Energy Market?", "NEG"),
    ("Valero Energy Q3 earnings on refining strength", "POS"),
    ("A 10-Day Losing Streak Has KLA Stock Down 20%", "NEG"),
    # phrases
    ("InnovestX cuts target to THB 60.00 for CP ALL stock", "NEG"),
    ("Analyst raises price target on Nvidia", "POS"),
    ("Stocks hit a record high", "POS"),
    # words that mean something else in a headline
    ("ProShares UltraShort Russell2000 Breaks Above 200-Day Moving Average", "NEU"),
    ("Jobless claims at 230,000", "NEU"),
    ("Fed rate cut expected in December", "NEU"),
    ("Best stocks to buy now despite the noise", "NEU"),
    # one each way
    ("Intel stock surges, raising valuation concerns", "NEU"),
    # whole words only
    ("Rosemont names Fallon as chief executive", "NEU"),
])
def test_tone(title, tone):
    assert ht.tone_of(title) == tone


def test_each_word_counts_once():
    # "downgrade" is a move word and could be a dictionary word too
    assert ht.tone_counts("Analyst downgrade") == (0, 1)


def test_without_the_dictionary_moves_still_work(monkeypatch):
    monkeypatch.setattr(ht, "_lm", (frozenset(), frozenset()))
    assert ht.tone_of("Why Micron Stock Dropped") == "NEG"
    assert ht.tone_of("Faces bankruptcy") == "NEU"


def test_fetch_checks_the_pinned_hash(monkeypatch, tmp_path):
    csv_text = "Word,Negative,Positive\nBANKRUPTCY,2009,0\nSTRENGTH,0,2009\nNEUTRAL,0,0\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(ht._LM_WHEEL["member"], csv_text)
    payload = buf.getvalue()

    class Resp:
        content = payload

        def raise_for_status(self):
            pass

    import requests
    monkeypatch.setattr(requests, "get", lambda url, timeout: Resp())
    monkeypatch.setattr(ht, "_LM_FILE", tmp_path / "lm.json")
    with pytest.raises(ValueError, match="sha256"):
        ht.fetch_lm()  # not the pinned wheel
    import hashlib
    monkeypatch.setitem(ht._LM_WHEEL, "sha256", hashlib.sha256(payload).hexdigest())
    data = ht.fetch_lm()
    assert data["negative"] == ["bankruptcy"] and data["positive"] == ["strength"]
    assert (tmp_path / "lm.json").is_file()
