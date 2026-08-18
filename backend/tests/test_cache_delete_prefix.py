"""
Unit tests for TTLCache.delete_prefix (backend/cache.py).

Run:
    cd backend
    python -m pytest tests/test_cache_delete_prefix.py -v
"""

import sys

sys.path.insert(0, ".")

from cache import TTLCache


def _cache() -> TTLCache:
    c = TTLCache(ttl=600, maxsize=50)
    c.set("sd:SPY:1y:cheapness:30:21:63", "a")
    c.set("sd:SPY:1y:occupancy:30:21:63", "b")
    c.set("sd:SPY:6mo:cheapness:60:21:63", "c")
    c.set("sd:SPYX:1y:cheapness:30:21:63", "d")
    c.set("sd:AMD:1y:cheapness:30:21:63", "e")
    c.set("chain:SPY:default", "f")
    return c


def test_removes_every_matching_key_and_reports_the_count():
    c = _cache()
    assert c.delete_prefix("sd:SPY:") == 3
    assert c.get("sd:SPY:1y:cheapness:30:21:63") is None
    assert c.get("sd:SPY:1y:occupancy:30:21:63") is None
    assert c.get("sd:SPY:6mo:cheapness:60:21:63") is None


def test_leaves_other_subjects_untouched():
    c = _cache()
    c.delete_prefix("sd:SPY:")
    assert c.get("sd:AMD:1y:cheapness:30:21:63") == "e"
    assert c.get("chain:SPY:default") == "f"


def test_the_trailing_separator_is_what_stops_a_prefix_collision():
    """`sd:SPY` without the colon would also take SPYX with it — the reason the
    caller passes the separator."""
    c = _cache()
    c.delete_prefix("sd:SPY:")
    assert c.get("sd:SPYX:1y:cheapness:30:21:63") == "d"

    c2 = _cache()
    assert c2.delete_prefix("sd:SPY") == 4  # SPYX swept up too


def test_no_match_is_a_no_op():
    c = _cache()
    before = len(c)
    assert c.delete_prefix("sd:NOSUCH:") == 0
    assert len(c) == before


def test_empty_prefix_clears_everything():
    c = _cache()
    assert c.delete_prefix("") == 6
    assert len(c) == 0
