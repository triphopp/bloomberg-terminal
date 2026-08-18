"""
Unit tests for backend/iv_scheduler.py

The gating logic is what matters here: get it wrong in one direction and the
series silently stops growing (a permanent hole — IV history cannot be
back-filled), get it wrong in the other and every pass re-probes the provider for
data it already has.

Run:
    cd backend
    python -m pytest tests/test_iv_scheduler.py -v
"""

import shutil
import sys
import tempfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, ".")

ET = ZoneInfo("America/New_York")


@pytest.fixture()
def scratch_dir():
    """Private dir for the test DB — this box denies access to the system temp
    root, so pytest's own `tmp_path` cannot enumerate its base dir."""
    root = Path(__file__).parent / "_tmp"
    root.mkdir(exist_ok=True)
    path = Path(tempfile.mkdtemp(dir=root))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


@pytest.fixture()
def env(scratch_dir, monkeypatch):
    import config

    monkeypatch.setattr(config, "DB_PATH", scratch_dir / "test.db", raising=False)
    import db

    monkeypatch.setattr(db, "DB_PATH", scratch_dir / "test.db", raising=False)
    db.init_db()
    db.init_portfolio_v2()

    import iv_scheduler

    monkeypatch.setattr(iv_scheduler, "_no_options", set(), raising=False)
    monkeypatch.setattr(iv_scheduler, "_no_quote_today", {}, raising=False)
    monkeypatch.delenv("IV_SNAPSHOT_SYMBOLS", raising=False)
    monkeypatch.delenv("IV_SNAPSHOT_INTERVAL", raising=False)

    def pin(*symbols: str):
        with db.get_db() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO pin_groups (id, name) VALUES ('g1', 'test')"
            )
            for i, s in enumerate(symbols):
                conn.execute(
                    "INSERT INTO pinned_assets (id, symbol, group_id) VALUES (?,?,'g1')",
                    (f"p{i}-{s}", s),
                )

    def snap(symbol: str, day: date, dte: int = 30, created_at: str | None = None):
        with db.get_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO iv_snapshots (symbol, snapshot_date, expiry, dte,"
                " spot, atm_strike, iv_call, iv_put, iv_mid, source, created_at)"
                " VALUES (?,?,?,?,100,100,0.2,0.2,0.2,'test',?)",
                (
                    symbol,
                    day.isoformat(),
                    (day + timedelta(days=dte)).isoformat(),
                    dte,
                    created_at or f"{day.isoformat()} 12:00:00",
                ),
            )

    return {"iv": iv_scheduler, "db": db, "pin": pin, "snap": snap}


# ── Symbol universe ───────────────────────────────────────────────────────────

def test_universe_is_watchlist_union_existing_history(env):
    """A series started by opening the indicator on SPY must keep going even
    though SPY was never pinned — the gap could not be repaired later."""
    env["pin"]("AMD", "MSFT")
    env["snap"]("SPY", date.today())

    assert env["iv"].target_symbols() == ["AMD", "MSFT", "SPY"]


def test_universe_deduplicates_and_uppercases(env):
    env["pin"]("amd", "AMD")
    env["snap"]("AMD", date.today())
    assert env["iv"].target_symbols() == ["AMD"]


def test_universe_skips_symbols_known_to_have_no_chain(env):
    env["pin"]("AMD", "^VIX")
    env["iv"]._no_options.add("^VIX")
    assert env["iv"].target_symbols() == ["AMD"]


def test_env_override_replaces_the_db_universe(env, monkeypatch):
    env["pin"]("AMD")
    monkeypatch.setenv("IV_SNAPSHOT_SYMBOLS", "SPY, qqq ,NVDA")
    assert env["iv"].target_symbols() == ["SPY", "QQQ", "NVDA"]


def test_env_override_still_honours_the_no_chain_set(env, monkeypatch):
    monkeypatch.setenv("IV_SNAPSHOT_SYMBOLS", "SPY,^VIX")
    env["iv"]._no_options.add("^VIX")
    assert env["iv"].target_symbols() == ["SPY"]


def test_empty_universe_is_not_an_error(env):
    assert env["iv"].target_symbols() == []


# ── Self-gating ───────────────────────────────────────────────────────────────

def test_symbol_with_todays_row_is_not_re_recorded(env):
    today = date.today()
    env["snap"]("AMD", today)
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), False) == []


def test_symbol_with_no_row_today_is_needed(env):
    today = date.today()
    env["snap"]("AMD", today - timedelta(days=1))
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), False) == ["AMD"]


def test_front_week_row_does_not_count_as_covered(env):
    """Opening the OPTIONS tab during an expiry week leaves a 0–4 DTE row, which
    the σ-band endpoint excludes — so the day is still uncovered."""
    today = date.today()
    env["snap"]("AMD", today, dte=3)
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), False) == ["AMD"]


def test_zero_iv_row_does_not_count_as_covered(env):
    today = date.today()
    env["snap"]("AMD", today)
    with env["db"].get_db() as conn:
        conn.execute("UPDATE iv_snapshots SET iv_mid = 0 WHERE symbol = 'AMD'")
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), False) == ["AMD"]


def test_empty_symbol_list_short_circuits(env):
    assert env["iv"].symbols_needing_snapshot([], date.today().isoformat(), False) == []


def test_gating_reports_only_the_missing_ones(env):
    today = date.today()
    env["snap"]("AMD", today)
    env["snap"]("MSFT", today, dte=2)          # front week → still missing
    needing = env["iv"].symbols_needing_snapshot(
        ["AMD", "MSFT", "NVDA"], today.isoformat(), False
    )
    assert needing == ["MSFT", "NVDA"]


# ── Refresh after the close ───────────────────────────────────────────────────

def test_mid_session_row_is_refreshed_after_the_close(env):
    """A snapshot taken at 11:00 ET is a mid-session IV; once the close has passed
    it should be replaced by a closing-side mark."""
    today = date.today()
    mid_session_utc = datetime.now(ET).replace(hour=11, minute=0, second=0).astimezone(
        timezone.utc
    )
    env["snap"]("AMD", today, created_at=mid_session_utc.strftime("%Y-%m-%d %H:%M:%S"))

    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), True) == ["AMD"]
    # Before the close, the same row is good enough — no needless request.
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), False) == []


def test_post_close_row_is_not_refreshed_again(env):
    today = date.today()
    after_utc = datetime.now(ET).replace(hour=17, minute=30, second=0).astimezone(timezone.utc)
    env["snap"]("AMD", today, created_at=after_utc.strftime("%Y-%m-%d %H:%M:%S"))
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), True) == []


def test_unparseable_timestamp_is_treated_as_done(env):
    """Better to skip one refresh than to re-record on every pass forever."""
    today = date.today()
    env["snap"]("AMD", today, created_at="not-a-timestamp")
    assert env["iv"].symbols_needing_snapshot(["AMD"], today.isoformat(), True) == []


# ── Close detection ───────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "et_hour,expected",
    [(9, False), (12, False), (15, False), (16, True), (17, True), (23, True)],
)
def test_after_us_close_boundary(env, et_hour, expected):
    stamp = datetime.now(ET).replace(hour=et_hour, minute=30).astimezone(timezone.utc)
    assert env["iv"]._after_us_close(stamp) is expected


def test_after_us_close_converts_from_utc(env):
    """20:30 UTC is 16:30 ET in summer — the naive reading of the UTC hour would
    get this wrong in both directions depending on the season."""
    utc_2030 = datetime.now(timezone.utc).replace(hour=20, minute=30)
    et_hour = utc_2030.astimezone(ET).hour
    assert env["iv"]._after_us_close(utc_2030) is (et_hour >= 16)


# ── run_once ──────────────────────────────────────────────────────────────────

def test_run_once_skips_without_touching_the_network(env, monkeypatch):
    env["pin"]("AMD")
    env["snap"]("AMD", date.today())

    import routers.options as opt

    def boom(*a, **k):
        raise AssertionError("must not hit the provider when the day is covered")

    monkeypatch.setattr(opt, "record_snapshot_now", boom)

    out = env["iv"].run_once()
    assert out["skipped"] == "all covered"


def test_run_once_records_missing_symbols(env, monkeypatch):
    env["pin"]("AMD", "MSFT")
    calls: list[str] = []

    def fake(symbol, expiry=None, target_dte=30):
        calls.append(symbol)
        env["snap"](symbol, date.today())
        return {"symbol": symbol}

    monkeypatch.setattr("routers.options.record_snapshot_now", fake)

    out = env["iv"].run_once()
    assert sorted(calls) == ["AMD", "MSFT"]
    assert out["recorded"] == 2
    assert out["failed"] == 0


def test_a_404_is_permanent_and_a_422_only_lasts_the_day(env, monkeypatch):
    """No chain at all is permanent for this process. No usable ATM quote is a
    property of today's chain, so it must not blacklist the symbol outright."""
    from fastapi import HTTPException

    env["pin"]("^VIX", "THINLY")

    def fake(symbol, expiry=None, target_dte=30):
        raise HTTPException(status_code=404 if symbol == "^VIX" else 422, detail="x")

    monkeypatch.setattr("routers.options.record_snapshot_now", fake)

    out = env["iv"].run_once()
    assert out["noChain"] == 1
    assert out["failed"] == 1
    assert "^VIX" in env["iv"]._no_options
    assert "THINLY" not in env["iv"]._no_options
    assert env["iv"]._no_quote_today["THINLY"] == date.today().isoformat()


def test_a_422_symbol_is_not_retried_again_today(env, monkeypatch):
    """Measured on a real box this was 3 symbols × 8 passes of futile requests
    per day before the day-scoped skip existed."""
    from fastapi import HTTPException

    env["pin"]("THINLY")
    calls: list[str] = []

    def fake(symbol, expiry=None, target_dte=30):
        calls.append(symbol)
        raise HTTPException(status_code=422, detail="no usable ATM quote")

    monkeypatch.setattr("routers.options.record_snapshot_now", fake)

    env["iv"].run_once()
    env["iv"].run_once()
    env["iv"].run_once()
    assert calls == ["THINLY"]


def test_a_422_symbol_is_retried_the_next_day(env, monkeypatch):
    env["pin"]("THINLY")
    env["iv"]._no_quote_today["THINLY"] = (date.today() - timedelta(days=1)).isoformat()

    calls: list[str] = []

    def fake(symbol, expiry=None, target_dte=30):
        calls.append(symbol)
        env["snap"](symbol, date.today())
        return {"symbol": symbol}

    monkeypatch.setattr("routers.options.record_snapshot_now", fake)
    env["iv"].run_once()
    assert calls == ["THINLY"]


def test_one_bad_symbol_does_not_abort_the_pass(env, monkeypatch):
    env["pin"]("AMD", "BOOM", "MSFT")

    def fake(symbol, expiry=None, target_dte=30):
        if symbol == "BOOM":
            raise RuntimeError("provider exploded")
        env["snap"](symbol, date.today())
        return {"symbol": symbol}

    monkeypatch.setattr("routers.options.record_snapshot_now", fake)

    out = env["iv"].run_once()
    assert out["recorded"] == 2
    assert out["failed"] == 1


# ── Interval config ───────────────────────────────────────────────────────────

def test_interval_defaults_and_overrides(env, monkeypatch):
    assert env["iv"].interval_seconds() == env["iv"].DEFAULT_INTERVAL

    monkeypatch.setenv("IV_SNAPSHOT_INTERVAL", "900")
    assert env["iv"].interval_seconds() == 900

    monkeypatch.setenv("IV_SNAPSHOT_INTERVAL", "0")
    assert env["iv"].interval_seconds() == 0


def test_bad_interval_falls_back_to_the_default(env, monkeypatch):
    monkeypatch.setenv("IV_SNAPSHOT_INTERVAL", "nonsense")
    assert env["iv"].interval_seconds() == env["iv"].DEFAULT_INTERVAL


def test_disabled_recorder_starts_no_thread(env, monkeypatch):
    import threading

    monkeypatch.setenv("IV_SNAPSHOT_INTERVAL", "0")
    monkeypatch.setattr(env["iv"], "_started", False, raising=False)
    before = threading.active_count()
    env["iv"].start_background_recorder()
    assert threading.active_count() == before


# ── The scheduler → recorder call path ────────────────────────────────────────
#
# Every other test here mocks the recorder away, which is exactly why a real
# defect survived: the loop called the FastAPI *endpoint coroutine*, whose
# `target_dte` default is a `Query` marker object rather than an int, so each
# scheduled snapshot died in pick_snapshot_expiry with "unsupported operand
# type(s) for -: 'int' and 'Query'". Recorded as failed, per symbol, silently.
# These exercise the seam itself instead of stubbing it.

def test_run_once_calls_a_plain_function_not_the_endpoint(env):
    """The endpoint coroutine must not be what the loop invokes."""
    import inspect

    import routers.options as opt

    src = inspect.getsource(env["iv"].run_once)
    assert "record_snapshot_now" in src
    assert "record_iv_snapshot" not in src
    assert not inspect.iscoroutinefunction(opt.record_snapshot_now)


def test_recorder_defaults_are_real_values_not_query_markers(env):
    """Regression guard: a FastAPI default leaking into the core function is
    invisible until something calls it off the web path."""
    import inspect

    import routers.options as opt

    for name, param in inspect.signature(opt.record_snapshot_now).parameters.items():
        if param.default is inspect.Parameter.empty:
            continue
        assert not type(param.default).__name__.startswith("Query"), name

    assert opt.record_snapshot_now.__defaults__ == (None, opt.IV_SNAPSHOT_TARGET_DTE)


def test_the_whole_path_records_with_the_provider_stubbed(env, monkeypatch):
    """End to end through the real recorder — only the provider is faked, so a
    signature or type error anywhere in between still surfaces."""
    import pandas as pd

    import routers.options as opt

    env["pin"]("FAKE")
    today = date.today()

    class _Chain:
        calls = pd.DataFrame(
            {"strike": [100.0], "impliedVolatility": [0.30], "lastPrice": [1.0]}
        )
        puts = pd.DataFrame(
            {"strike": [100.0], "impliedVolatility": [0.34], "lastPrice": [1.0]}
        )

    class _Ticker:
        options = [
            (today + timedelta(days=d)).isoformat() for d in (1, 9, 31, 120)
        ]
        info = {"regularMarketPrice": 100.0}

        def option_chain(self, expiry):
            return _Chain()

    monkeypatch.setattr(opt.market_data, "get_ticker", lambda s: _Ticker())

    out = env["iv"].run_once()
    assert out["recorded"] == 1, out

    with env["db"].get_db() as conn:
        row = conn.execute(
            "SELECT symbol, dte, iv_mid FROM iv_snapshots WHERE symbol = 'FAKE'"
        ).fetchone()

    assert row is not None
    assert row["dte"] == 31          # nearest to the 30-day target, front week skipped
    assert row["iv_mid"] == pytest.approx(0.32)   # (0.30 + 0.34) / 2
