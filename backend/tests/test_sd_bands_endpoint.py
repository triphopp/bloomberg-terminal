"""
Endpoint tests for /api/options/{symbol}/sd-bands.

Runs against a throwaway SQLite file and a synthetic price series, so nothing
here touches the network or the real portfolio.db.

Run:
    cd backend
    python -m pytest tests/test_sd_bands_endpoint.py -v
"""

import asyncio
import math
import random
import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, ".")


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture()
def scratch_dir():
    """A private directory for the test DB.

    Not pytest's `tmp_path`: this box denies access to the system temp root, so
    the built-in fixture cannot even enumerate its own base dir. Kept beside the
    tests and removed afterwards.
    """
    root = Path(__file__).parent / "_tmp"
    root.mkdir(exist_ok=True)
    path = Path(tempfile.mkdtemp(dir=root))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


@pytest.fixture()
def sd_env(scratch_dir, monkeypatch):
    """Point db at a temp file, seed IV snapshots, stub out price history."""
    import config

    monkeypatch.setattr(config, "DB_PATH", scratch_dir / "test.db", raising=False)

    import db
    monkeypatch.setattr(db, "DB_PATH", scratch_dir / "test.db", raising=False)
    db.init_db()

    import routers.options as opt

    # Deterministic random walk, one bar per weekday, ending today.
    random.seed(11)
    n_days = 400
    start = date.today() - timedelta(days=n_days)
    dates: list[date] = []
    closes: list[float] = []
    price = 100.0
    d = start
    while d <= date.today():
        if d.weekday() < 5:
            price *= math.exp(random.gauss(0.0002, 0.011))
            dates.append(d)
            closes.append(price)
        d += timedelta(days=1)

    frame_df = pd.DataFrame({"Close": closes}, index=pd.DatetimeIndex(dates))

    class _Frame:
        df = frame_df

    monkeypatch.setattr(
        opt.market_data, "get_history", lambda symbol, period="1y", interval="1d": _Frame()
    )
    # The risk-free lookup hits FRED/yfinance otherwise.
    monkeypatch.setattr(opt, "_risk_free_rate", lambda: 0.04)
    opt._sd_bands_cache.clear() if hasattr(opt._sd_bands_cache, "clear") else None

    def seed(sigmas: dict[date, float], expiry_dte: int = 30, symbol: str = "TEST", spot: float = 100.0):
        with db.get_db() as conn:
            for snap_date, sigma in sigmas.items():
                conn.execute(
                    """
                    INSERT OR REPLACE INTO iv_snapshots
                        (symbol, snapshot_date, expiry, dte, spot, atm_strike,
                         iv_call, iv_put, iv_mid, source)
                    VALUES (?,?,?,?,?,?,?,?,?,'test')
                    """,
                    (
                        symbol,
                        snap_date.isoformat(),
                        (snap_date + timedelta(days=expiry_dte)).isoformat(),
                        expiry_dte,
                        spot,
                        spot,
                        sigma,
                        sigma,
                        sigma,
                    ),
                )

    return {"opt": opt, "db": db, "dates": dates, "closes": closes, "seed": seed}


def _call(opt, **kwargs):
    """Invoke the endpoint coroutine with defaults filled in."""
    params = {
        "symbol": "TEST",
        "period": "2y",
        "mode": "occupancy",
        "horizon_days": 30,
        "rv_window": 21,
        "occ_window": 63,
    }
    params.update(kwargs)
    opt._sd_bands_cache._store.clear()
    return asyncio.run(opt.get_sd_bands(**params))


# ── Empty-history behaviour ───────────────────────────────────────────────────

def test_no_snapshots_returns_note_not_error(sd_env):
    out = _call(sd_env["opt"])
    assert out["snapshotCount"] == 0
    assert out["series"] == []
    assert out["current"] is None
    assert "note" in out


def test_reference_probs_are_the_constants(sd_env):
    from analytics.sd_bands import BUCKET_PROBS

    out = _call(sd_env["opt"])
    assert out["levels"] == [-2, -1, 0, 1, 2]
    for got, want in zip(out["refProbs"], BUCKET_PROBS):
        assert got == pytest.approx(want, abs=1e-6)


# ── Occupancy mode ────────────────────────────────────────────────────────────

def test_occupancy_series_shape(sd_env):
    dates = sd_env["dates"]
    sd_env["seed"]({d: 0.25 for d in dates[::5]})

    out = _call(sd_env["opt"], mode="occupancy")
    assert out["snapshotCount"] > 0
    assert len(out["series"]) > 0

    row = out["series"][0]
    assert len(row["prices"]) == 5
    assert len(row["edges"]) == 6
    assert len(row["cells"]) == 5
    assert row["edges"][0] is None and row["edges"][-1] is None
    assert row["hitRow"] in (0, 1, 2, 3, 4)
    assert row["prices"] == sorted(row["prices"])


def test_occupancy_cells_are_a_distribution(sd_env):
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"][::3]})
    out = _call(sd_env["opt"], mode="occupancy")
    for row in out["series"]:
        # Tolerance is 1e-5, not 1e-6: cells are rounded to 6dp on the way out,
        # so five of them sum to 1 only up to that rounding.
        assert sum(row["cells"]) == pytest.approx(1.0, abs=1e-5)
        assert row["cells"][row["hitRow"]] > 0


def test_occupancy_right_edge_is_current(sd_env):
    """Columns are stamped at the TERMINAL bar, so the newest column is today —
    what is missing is the last horizon_days of ANCHORS, whose outcome is not
    known yet. `current` carries that still-open projection."""
    dates = sd_env["dates"]
    sd_env["seed"]({d: 0.25 for d in dates})

    out = _call(sd_env["opt"], mode="occupancy", horizon_days=30)
    # Near the right edge, not exactly ON it: whether the newest bar can be a
    # terminal depends on where anchor+30d lands in the week. Asserting equality
    # made this test pass or fail according to the calendar day it ran on.
    last_col = date.fromisoformat(out["series"][-1]["time"])
    assert (dates[-1] - last_col).days <= 5

    last_anchor = date.fromisoformat(out["series"][-1]["anchorTime"])
    assert (last_col - last_anchor).days >= 30

    assert out["current"] is not None
    assert out["current"]["targetDate"] > date.today().isoformat()
    # Every anchor from the last horizon_days is still unresolved.
    assert len(out["series"]) < out["snapshotCount"]


def test_occupancy_hit_row_matches_the_edges(sd_env):
    """hitRow must be consistent with the published edges — the row a reader
    would derive from `terminal` and `edges` themselves."""
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"][::7]})
    out = _call(sd_env["opt"], mode="occupancy")

    for row in out["series"]:
        edges = [e if e is not None else None for e in row["edges"]]
        term = row["terminal"]
        derived = 0
        for k in range(5):
            lo = edges[k]
            hi = edges[k + 1]
            if (lo is None or term >= lo) and (hi is None or term < hi):
                derived = k
                break
        assert derived == row["hitRow"], row


def test_occupancy_low_iv_pushes_hits_into_the_tails(sd_env):
    """Understated vol → realized moves fall outside the band more often, so
    tail rows carry more mass than the 6.68% reference."""
    dates = sd_env["dates"]
    # 4%, not 2%: anything under IV_SANITY_MIN is now refused as a data artefact,
    # and this test is about understated vol, not junk vol.
    sd_env["seed"]({d: 0.04 for d in dates[::3]})

    out = _call(sd_env["opt"], mode="occupancy")
    tail_share = out["series"][-1]["cells"][0] + out["series"][-1]["cells"][4]
    assert tail_share > 2 * (out["refProbs"][0] + out["refProbs"][4])


def test_occupancy_high_iv_collapses_hits_into_the_centre(sd_env):
    dates = sd_env["dates"]
    sd_env["seed"]({d: 0.60 for d in dates[::3]})

    out = _call(sd_env["opt"], mode="occupancy")
    assert out["series"][-1]["cells"][2] > 0.85


def test_occupancy_absurd_iv_shifts_hits_upward_not_to_centre(sd_env):
    """Documents a real consequence of the risk-neutral MEDIAN drift: at σ=3 the
    −σ²/2·T term drags row 0 about 31% below spot over 30 days, so a flat tape
    reads as an UP move relative to the band rather than a central one. Not a
    bug — the reason `prices[2]` must never be described as 'spot'."""
    dates = sd_env["dates"]
    sd_env["seed"]({d: 3.0 for d in dates[::3]})

    out = _call(sd_env["opt"], mode="occupancy")
    row = out["series"][-1]
    assert row["cells"][3] + row["cells"][4] > 0
    assert row["prices"][2] < 0.75 * row["spot"]


def test_occupancy_columns_are_unique_and_ascending(sd_env):
    """Weekend/holiday gaps make several anchors resolve to the same terminal
    bar. The chart's anchor series requires strictly ascending unique times, so
    duplicates must be collapsed, not appended."""
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"]})
    out = _call(sd_env["opt"], mode="occupancy")

    times = [row["time"] for row in out["series"]]
    assert len(times) == len(set(times))
    assert times == sorted(times)


def test_occupancy_collapsed_column_keeps_the_freshest_anchor(sd_env):
    """When two anchors collide on one terminal bar the later projection wins —
    a stale band must not shadow a newer one."""
    dates = sd_env["dates"]
    sd_env["seed"]({d: 0.25 for d in dates})
    out = _call(sd_env["opt"], mode="occupancy", horizon_days=30)

    for row in out["series"]:
        gap = (date.fromisoformat(row["time"]) - date.fromisoformat(row["anchorTime"])).days
        # A fresher anchor for the same bar would have a smaller gap; 30–34 days
        # is the window a weekend can stretch the horizon into.
        assert 30 <= gap <= 34, row


def test_occupancy_sample_size_respects_window(sd_env):
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"]})
    out = _call(sd_env["opt"], mode="occupancy", occ_window=10)
    assert out["series"][-1]["sampleSize"] == 10


# ── Cheapness mode ────────────────────────────────────────────────────────────

def test_cheapness_cells_sum_to_zero(sd_env):
    """cells = P_rv − P_iv over a partition, so the column must net to zero."""
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"][::3]})
    out = _call(sd_env["opt"], mode="cheapness")
    assert len(out["series"]) > 0
    for row in out["series"]:
        # 1e-5, not 1e-6: the payload rounds each cell to 6dp.
        assert sum(row["cells"]) == pytest.approx(0.0, abs=1e-5)
        assert sum(row["rvProbs"]) == pytest.approx(1.0, abs=1e-5)


def test_cheapness_high_iv_marks_tails_expensive(sd_env):
    """IV far above realized → RV puts less mass in the tails than IV prices,
    so the tail cells go negative."""
    sd_env["seed"]({d: 1.2 for d in sd_env["dates"][::3]})
    out = _call(sd_env["opt"], mode="cheapness")
    row = out["series"][-1]
    assert row["cells"][0] < 0
    assert row["cells"][4] < 0
    assert row["cells"][2] > 0


def test_cheapness_low_iv_marks_tails_cheap(sd_env):
    sd_env["seed"]({d: 0.03 for d in sd_env["dates"][::3]})
    out = _call(sd_env["opt"], mode="cheapness")
    row = out["series"][-1]
    assert row["cells"][0] > 0
    assert row["cells"][4] > 0
    assert row["cells"][2] < 0


def test_cheapness_runs_up_to_the_newest_snapshot(sd_env):
    """Unlike occupancy, cheapness needs no terminal bar."""
    dates = sd_env["dates"]
    sd_env["seed"]({d: 0.25 for d in dates[-40:]})
    out = _call(sd_env["opt"], mode="cheapness")
    assert out["series"][-1]["time"] == dates[-1].isoformat()


# ── Band arithmetic surfaced through the endpoint ─────────────────────────────

def test_row_zero_below_spot_for_high_iv(sd_env):
    """Risk-neutral MEDIAN, not the forward: at high sigma the −σ²/2 term
    dominates the +r term, so row 0 sits below spot."""
    sd_env["seed"]({d: 0.80 for d in sd_env["dates"][::3]})
    out = _call(sd_env["opt"], mode="cheapness")
    row = out["series"][-1]
    assert row["prices"][2] < row["spot"]


def test_band_widens_with_horizon(sd_env):
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"][::3]})
    short = _call(sd_env["opt"], mode="cheapness", horizon_days=7)["series"][-1]
    long = _call(sd_env["opt"], mode="cheapness", horizon_days=180)["series"][-1]
    assert long["prices"][4] > short["prices"][4]
    assert long["prices"][0] < short["prices"][0]


def test_bad_mode_rejected(sd_env):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _call(sd_env["opt"], mode="nonsense")
    assert exc.value.status_code == 400


# ── Snapshot recording ────────────────────────────────────────────────────────

def test_record_iv_snapshot_upserts(sd_env):
    opt, db = sd_env["opt"], sd_env["db"]
    expiry = (date.today() + timedelta(days=30)).isoformat()

    assert opt._record_iv_snapshot("AAA", expiry, 100.0, 100.0, 0.20, 0.30, 0.25)
    assert opt._record_iv_snapshot("AAA", expiry, 101.0, 100.0, 0.22, 0.32, 0.27)

    with db.get_db() as conn:
        rows = conn.execute("SELECT * FROM iv_snapshots WHERE symbol='AAA'").fetchall()
    assert len(rows) == 1
    assert rows[0]["iv_mid"] == pytest.approx(0.27)
    assert rows[0]["spot"] == pytest.approx(101.0)


def test_recording_a_snapshot_invalidates_the_sd_bands_cache(sd_env):
    """The bug the user actually hit: the empty answer was cached for 600s, so
    recording a snapshot stayed invisible and the pane kept saying there was no
    IV history — at exactly the moment they were watching it."""
    opt = sd_env["opt"]
    expiry = (date.today() + timedelta(days=30)).isoformat()

    # Warm the cache with the empty answer, the way opening the pane does.
    first = asyncio.run(
        opt.get_sd_bands(
            symbol="TEST", period="2y", mode="cheapness",
            horizon_days=30, rv_window=21, occ_window=63,
        )
    )
    assert first["snapshotCount"] == 0

    assert opt._record_iv_snapshot("TEST", expiry, 100.0, 100.0, 0.20, 0.30, 0.25)

    # Same cache key, no manual clear — must reflect the write.
    second = asyncio.run(
        opt.get_sd_bands(
            symbol="TEST", period="2y", mode="cheapness",
            horizon_days=30, rv_window=21, occ_window=63,
        )
    )
    assert second["snapshotCount"] == 1


def test_cache_invalidation_covers_every_param_variant(sd_env):
    """The key encodes period/mode/horizon/windows, so one symbol fans out into
    many entries — dropping only the current one leaves the rest stale."""
    opt = sd_env["opt"]
    expiry = (date.today() + timedelta(days=30)).isoformat()

    variants = [
        {"mode": "cheapness", "horizon_days": 30},
        {"mode": "cheapness", "horizon_days": 60},
        {"mode": "occupancy", "horizon_days": 30},
    ]
    for v in variants:
        asyncio.run(
            opt.get_sd_bands(
                symbol="TEST", period="2y", rv_window=21, occ_window=63, **v
            )
        )
    assert len(opt._sd_bands_cache) >= 3

    opt._record_iv_snapshot("TEST", expiry, 100.0, 100.0, 0.20, 0.30, 0.25)

    for v in variants:
        out = asyncio.run(
            opt.get_sd_bands(
                symbol="TEST", period="2y", rv_window=21, occ_window=63, **v
            )
        )
        assert out["snapshotCount"] == 1, v


def test_cache_invalidation_leaves_other_symbols_alone(sd_env):
    opt = sd_env["opt"]
    sd_env["seed"]({d: 0.25 for d in sd_env["dates"][::3]}, symbol="OTHER")

    warm = asyncio.run(
        opt.get_sd_bands(
            symbol="OTHER", period="2y", mode="cheapness",
            horizon_days=30, rv_window=21, occ_window=63,
        )
    )
    assert warm["snapshotCount"] > 0

    opt._record_iv_snapshot(
        "TEST", (date.today() + timedelta(days=30)).isoformat(), 100.0, 100.0, 0.2, 0.2, 0.2
    )
    assert opt._sd_bands_cache.get("sd:OTHER:2y:cheapness:30:21:63") is not None


def test_record_iv_snapshot_skips_unusable_input(sd_env):
    opt = sd_env["opt"]
    expiry = (date.today() + timedelta(days=30)).isoformat()
    assert not opt._record_iv_snapshot("BBB", expiry, 100.0, 100.0, None, None, None)
    assert not opt._record_iv_snapshot("BBB", expiry, 0.0, 100.0, 0.2, 0.2, 0.2)
    assert not opt._record_iv_snapshot("BBB", "not-a-date", 100.0, 100.0, 0.2, 0.2, 0.2)


def _seed_expiries(db, snap: date, pairs: list[tuple[int, float]], symbol: str = "TEST"):
    with db.get_db() as conn:
        for dte, sigma in pairs:
            conn.execute(
                "INSERT OR REPLACE INTO iv_snapshots (symbol, snapshot_date, expiry, dte, spot,"
                " atm_strike, iv_call, iv_put, iv_mid, source)"
                " VALUES (?,?,?,?,100,100,?,?,?,'test')",
                (
                    symbol,
                    snap.isoformat(),
                    (snap + timedelta(days=dte)).isoformat(),
                    dte,
                    sigma,
                    sigma,
                    sigma,
                ),
            )


def test_expiry_closest_to_the_horizon_wins_per_day(sd_env):
    """Several expiries snapshotted the same day → the band uses the one nearest
    the horizon it is projecting, NOT the nearest expiry."""
    opt, db = sd_env["opt"], sd_env["db"]
    snap = sd_env["dates"][-60]
    _seed_expiries(db, snap, [(8, 0.15), (31, 0.30), (120, 0.45)])

    out = _call(opt, mode="cheapness", horizon_days=30)
    row = next(r for r in out["series"] if r["time"] == snap.isoformat())
    assert row["dteAtSnapshot"] == 31
    assert row["sigmaIv"] == pytest.approx(0.30)


def test_a_longer_horizon_selects_a_longer_expiry(sd_env):
    opt, db = sd_env["opt"], sd_env["db"]
    snap = sd_env["dates"][-60]
    _seed_expiries(db, snap, [(8, 0.15), (31, 0.30), (120, 0.45)])

    out = _call(opt, mode="cheapness", horizon_days=110)
    row = next(r for r in out["series"] if r["time"] == snap.isoformat())
    assert row["dteAtSnapshot"] == 120
    assert row["sigmaIv"] == pytest.approx(0.45)


def test_front_week_snapshots_are_excluded_entirely(sd_env):
    """0DTE ATM IV is pin risk, not a 30-day view — measured live at 12.3% call
    vs 15.8% put on SPY and 19.5% vs 59.7% on AMD."""
    opt, db = sd_env["opt"], sd_env["db"]
    for d in sd_env["dates"][-40:]:
        _seed_expiries(db, d, [(0, 0.9), (3, 0.8)])

    out = _call(opt, mode="cheapness")
    assert out["snapshotCount"] == 0
    assert out["series"] == []
    # And it must not claim nothing was recorded — that would send the user to
    # repeat the action that already produced these rows.
    assert out["rawSnapshotCount"] > 0
    assert "front week" in out["note"]


def test_no_snapshots_at_all_says_so(sd_env):
    out = _call(sd_env["opt"], mode="cheapness")
    assert out["snapshotCount"] == 0
    assert out.get("rawSnapshotCount") == 0
    assert "No IV snapshots yet" in out["note"]


# ── Expiry selection (pure) ───────────────────────────────────────────────────

def test_pick_snapshot_expiry_targets_30_days(sd_env):
    opt = sd_env["opt"]
    today = date.today()
    exps = [(today + timedelta(days=d)).isoformat() for d in (0, 1, 8, 29, 60, 200)]
    assert opt.pick_snapshot_expiry(exps) == exps[3]   # 29 DTE


def test_pick_snapshot_expiry_skips_the_front_week(sd_env):
    """The default `expirations[0]` would be the 0DTE contract."""
    opt = sd_env["opt"]
    today = date.today()
    exps = [(today + timedelta(days=d)).isoformat() for d in (0, 2, 45)]
    assert opt.pick_snapshot_expiry(exps) == exps[2]


def test_pick_snapshot_expiry_falls_back_to_the_longest_when_all_are_near(sd_env):
    opt = sd_env["opt"]
    today = date.today()
    exps = [(today + timedelta(days=d)).isoformat() for d in (0, 1, 4)]
    assert opt.pick_snapshot_expiry(exps) == exps[2]


def test_pick_snapshot_expiry_breaks_ties_toward_the_longer_expiry(sd_env):
    opt = sd_env["opt"]
    today = date.today()
    exps = [(today + timedelta(days=d)).isoformat() for d in (20, 40)]  # both 10 away
    assert opt.pick_snapshot_expiry(exps, target_dte=30) == exps[1]


def test_pick_snapshot_expiry_honours_an_explicit_target(sd_env):
    opt = sd_env["opt"]
    today = date.today()
    exps = [(today + timedelta(days=d)).isoformat() for d in (10, 30, 90, 180)]
    assert opt.pick_snapshot_expiry(exps, target_dte=95) == exps[2]


def test_pick_snapshot_expiry_handles_empty_and_garbage(sd_env):
    opt = sd_env["opt"]
    assert opt.pick_snapshot_expiry([]) is None
    assert opt.pick_snapshot_expiry(["not-a-date", ""]) is None


# ── Snapshots on days with no bar ─────────────────────────────────────────────

def test_a_snapshot_on_a_market_holiday_still_produces_a_column(sd_env):
    """The bug that emptied a working pane: a snapshot recorded on a day the US
    market was shut had no bar of its own, so the exact-date lookup found no
    realized vol and cheapness mode dropped the row entirely — leaving
    `snapshotCount: 1` next to an empty `series`."""
    dates = sd_env["dates"]
    # Saturday: guaranteed to have no bar in the weekday-only fixture.
    holiday = dates[-1] + timedelta(days=(5 - dates[-1].weekday()) % 7 or 7)
    sd_env["seed"]({holiday: 0.30})

    out = _call(sd_env["opt"], mode="cheapness")
    assert out["snapshotCount"] == 1
    assert len(out["series"]) == 1
    assert out["series"][0]["sigmaRv"] is not None


def test_a_holiday_column_is_stamped_on_a_real_bar(sd_env):
    """The chart matches columns to bars by date, so a column stamped on a day
    with no bar is silently dropped by the renderer even when the backend got
    every number right."""
    dates = sd_env["dates"]
    holiday = dates[-1] + timedelta(days=(5 - dates[-1].weekday()) % 7 or 7)
    sd_env["seed"]({holiday: 0.30})

    row = _call(sd_env["opt"], mode="cheapness")["series"][0]
    assert date.fromisoformat(row["time"]) in dates
    # The original date is kept so the reading is still traceable.
    assert row["snapshotDate"] == holiday.isoformat()


def test_consecutive_holidays_collapse_onto_one_column(sd_env):
    """Several snapshots anchoring to the same bar would emit duplicate times,
    which the chart's anchor series rejects outright."""
    dates = sd_env["dates"]
    last = dates[-1]
    sd_env["seed"]({last + timedelta(days=n): 0.30 for n in (1, 2, 3)})

    out = _call(sd_env["opt"], mode="cheapness")
    times = [r["time"] for r in out["series"]]
    assert len(times) == len(set(times))
    assert times == sorted(times)


def test_the_freshest_snapshot_wins_a_shared_bar(sd_env):
    dates = sd_env["dates"]
    last = dates[-1]
    sd_env["seed"]({last + timedelta(days=1): 0.20})
    sd_env["seed"]({last + timedelta(days=2): 0.90})

    out = _call(sd_env["opt"], mode="cheapness")
    assert out["series"][-1]["sigmaIv"] == pytest.approx(0.90)


# ── IV sanity band ────────────────────────────────────────────────────────────

def test_an_implausible_iv_is_refused_at_the_door(sd_env):
    """A thin chain quotes at intrinsic, and solving that back out yields a
    "vol" of a percent or two. Observed live: SK hynix's ADR came back at 1.56%
    ATM against 111% realized, drawing a σ-band ±0.45% wide and lighting both
    tails as maximally cheap — a data artefact dressed as a signal."""
    opt = sd_env["opt"]
    expiry = (date.today() + timedelta(days=30)).isoformat()
    assert not opt._record_iv_snapshot("THIN", expiry, 100.0, 100.0, 0.015, 0.016, 0.0156)


def test_an_absurdly_high_iv_is_refused_too(sd_env):
    opt = sd_env["opt"]
    expiry = (date.today() + timedelta(days=30)).isoformat()
    assert not opt._record_iv_snapshot("WILD", expiry, 100.0, 100.0, 8.0, 8.0, 8.0)


def test_a_normal_iv_still_passes(sd_env):
    opt = sd_env["opt"]
    expiry = (date.today() + timedelta(days=30)).isoformat()
    assert opt._record_iv_snapshot("OK", expiry, 100.0, 100.0, 0.20, 0.24, 0.22)
    # A quiet bond ETF sits near the floor and must NOT be caught by it.
    assert opt._record_iv_snapshot("CALM", expiry, 100.0, 100.0, 0.09, 0.11, 0.10)


def test_rows_stored_before_the_rule_existed_are_ignored_on_read(sd_env):
    """The sanity band is applied on the read path too — a junk row already in
    the DB would otherwise keep poisoning the pane forever."""
    dates = sd_env["dates"]
    sd_env["seed"]({d: 0.0156 for d in dates[::3]})   # bypasses the write guard

    out = _call(sd_env["opt"], mode="cheapness")
    assert out["snapshotCount"] == 0
    assert out["series"] == []
