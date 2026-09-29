"""Yahoo's newest bar for once-a-day indices carries O/H/L = 0 (^MOVE, 2026-09-28)."""

from routers.stock import _repair_zero_ohl


def _bar(o, h, l, c):
    return {"date": "d", "open": o, "high": h, "low": l, "close": c, "volume": 0}


def test_zero_ohl_rebuilt_from_previous_close():
    quotes = [_bar(104.58, 104.58, 96.0, 96.0), _bar(0.0, 0.0, 0.0, 101.8206)]
    _repair_zero_ohl(quotes)
    assert quotes[1] == _bar(96.0, 101.8206, 96.0, 101.8206)


def test_first_bar_zero_falls_back_to_close():
    quotes = [_bar(0.0, 0.0, 0.0, 50.0)]
    _repair_zero_ohl(quotes)
    assert quotes[0] == _bar(50.0, 50.0, 50.0, 50.0)


def test_only_low_zero_keeps_real_fields():
    quotes = [_bar(10.0, 12.0, 0.0, 11.0)]
    _repair_zero_ohl(quotes)
    assert quotes[0] == _bar(10.0, 12.0, 10.0, 11.0)


def test_valid_bars_untouched():
    quotes = [_bar(1.0, 2.0, 0.5, 1.5), _bar(1.5, 1.8, 1.2, 1.6)]
    before = [dict(q) for q in quotes]
    _repair_zero_ohl(quotes)
    assert quotes == before
