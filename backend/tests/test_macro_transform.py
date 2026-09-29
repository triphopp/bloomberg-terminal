"""_apply_transform lags by date, never by row: FRED has holes (no Oct-2025 CPI)."""
from routers.macro import _apply_transform


def _monthly(start_year: int, start_month: int, values: list[float], skip: set[str] = frozenset()):
    """Newest-first rows from oldest-first values, dropping the YYYY-MM in `skip`."""
    rows, y, m = [], start_year, start_month
    for v in values:
        d = f"{y:04d}-{m:02d}-01"
        if d[:7] not in skip:
            rows.append({"date": d, "raw": v})
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return rows[::-1]


def test_yoy_matches_the_same_month_a_year_ago_across_a_missing_month():
    # 2025-01 … 2026-08 = 100, 101, … ; Oct-2025 missing (shutdown).
    rows = _monthly(2025, 1, [100 + i for i in range(20)], skip={"2025-10"})
    out = {r["date"]: r["value"] for r in _apply_transform(rows, "yoy_pct")}
    # Aug-2026 (119) vs Aug-2025 (107) — a 12-row lag would reach Jul-2025 (106).
    assert out["2026-08-01"] == round((119 - 107) / 107 * 100, 2)
    # Oct-2026 does not exist; Oct-2025 is the missing base → no Oct point at all.
    assert "2026-10-01" not in out
    # Months whose base is before the data start are skipped, not guessed.
    assert "2025-12-01" not in out
    assert sorted(out) == [f"2026-{m:02d}-01" for m in range(1, 9)]


def test_mom_pct_and_mom_diff_skip_the_month_after_a_gap():
    rows = _monthly(2025, 8, [100, 110, 999, 121], skip={"2025-10"})
    pct = {r["date"]: r["value"] for r in _apply_transform(rows, "mom_pct")}
    diff = {r["date"]: r["value"] for r in _apply_transform(rows, "mom_diff")}
    assert pct == {"2025-09-01": 10.0}
    assert diff == {"2025-09-01": 10.0}


def test_quarterly_yoy_uses_the_same_quarter_a_year_ago():
    rows = [
        {"date": "2026-04-01", "raw": 110.0},
        {"date": "2025-10-01", "raw": 105.0},   # 2026-01 missing
        {"date": "2025-07-01", "raw": 104.0},
        {"date": "2025-04-01", "raw": 100.0},
        {"date": "2025-01-01", "raw": 99.0},
    ]
    out = {r["date"]: r["value"] for r in _apply_transform(rows, "yoy_pct_q")}
    # 4-row offset would compare 2026-04 with 2025-01 (99) → 11.11.
    assert out == {"2026-04-01": 10.0}


def test_direct_passes_values_through():
    rows = [{"date": "2026-08-01", "raw": 4.123456}]
    assert _apply_transform(rows, "direct") == [{"date": "2026-08-01", "value": 4.1235}]
