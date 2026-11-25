"""TAIL history: the daily board record and the rebuilt signal export.

Network-free: the snapshot tests use a temp DB, the export tests feed synthetic
series through the live signal frames.
"""
import csv
import importlib
import io

import numpy as np
import pandas as pd
import pytest


@pytest.fixture()
def snaps(tmp_path, monkeypatch):
    monkeypatch.setenv("PORTFOLIO_DB", str(tmp_path / "tail.db"))
    import config
    importlib.reload(config)
    import db
    importlib.reload(db)
    db.init_tail_snapshot_schema()
    import tail_snapshots
    importlib.reload(tail_snapshots)
    return tail_snapshots


def _payload(day="2026-11-24", ts="2026-11-25T01:00:00Z", level="ELEVATED", vix_state="on"):
    return {
        "ok": True,
        "ts": ts,
        "data_date": day,
        "risk_level": level,
        "risk_level_dimensions": level,
        "risk_basis": {"driver": "dimensions", "events": "CAUTION"},
        "alert_dimensions": ["tail_pricing"],
        "watch_dimensions": ["equity_vol", "credit"],
        "signals": [
            {"id": "vix_level", "dimension": "equity_vol", "state": vix_state, "value": 31.2,
             "detail": "z63 2.1", "reason": None, "counted": True, "rule": "long text dropped"},
            {"id": "hy_spread", "dimension": "credit", "state": "unknown", "value": None,
             "detail": None, "reason": "FRED down", "counted": True},
        ],
        "dimensions": [{"id": "equity_vol", "status": "WATCH", "on_count": 1, "total": 3,
                        "unknown_count": 0, "active_signals": ["vix_level"], "question": "dropped"}],
        "events": [{"id": "equity_vol_shock", "name": "Equity Volatility Shock", "severity": "SEVERE",
                    "channel": "equity_vol", "summary": "static text dropped", "evidence": [{"k": 1}]}],
        "fear_greed": 22.5,
        "spy_rsi": 41.0,
        "sector_regime": "DIVERGENT",
        "dcc_v1_signal": "SPIKE",
        "data_health": {"unknown_signals": ["hy_spread"]},
    }


def test_one_row_per_market_date_newest_reading_wins(snaps):
    assert snaps.record(_payload(level="CAUTION", ts="2026-11-25T01:00:00Z"))
    assert snaps.record(_payload(level="ELEVATED", ts="2026-11-25T03:00:00Z"))
    # the same compute seen again, and an older cached board: neither writes
    assert not snaps.record(_payload(level="ELEVATED", ts="2026-11-25T03:00:00Z"))
    assert not snaps.record(_payload(level="NORMAL", ts="2026-11-25T02:00:00Z"))
    rows = snaps.list_rows()
    assert len(rows) == 1
    r = rows[0]
    assert r["risk_level"] == "ELEVATED"
    assert r["reads"] == 2
    assert r["signals_json"][0] == {"id": "vix_level", "dimension": "equity_vol", "state": "on",
                                    "value": 31.2, "detail": "z63 2.1", "reason": None, "counted": True}
    assert "summary" not in r["events_json"][0] and r["events_json"][0]["severity"] == "SEVERE"
    assert r["context_json"]["dcc_v1_signal"] == "SPIKE"
    assert snaps.summary() == {"count": 1, "first": "2026-11-24", "last": "2026-11-24"}


def test_failed_or_dateless_board_is_not_recorded(snaps):
    assert not snaps.record({"ok": False, "ts": "x", "data_date": "2026-11-24"})
    assert not snaps.record({**_payload(), "data_date": "N/A"})
    assert snaps.list_rows() == []


def test_csv_has_one_line_per_date_and_a_column_per_signal(snaps):
    snaps.record(_payload(day="2026-11-23", vix_state="off"))
    snaps.record(_payload(day="2026-11-24"))
    text = snaps.to_csv(snaps.list_rows(), ["vix_level", "vix_momentum", "hy_spread"])
    rows = list(csv.DictReader(io.StringIO(text)))
    assert [r["date"] for r in rows] == ["2026-11-23", "2026-11-24"]
    assert rows[0]["vix_level"] == "off" and rows[1]["vix_level"] == "on"
    assert rows[1]["vix_level_value"] == "31.2"
    assert rows[1]["vix_momentum"] == ""  # in the order, not on the board that day
    assert rows[1]["hy_spread"] == "unknown"
    assert rows[1]["events"] == "equity_vol_shock" and rows[1]["event_severities"] == "SEVERE"
    assert rows[1]["watch_dimensions"] == "equity_vol;credit"


# ── Export rebuilt from the live frames ──────────────────────────────────────


class _Health:
    ok = True
    reason = ""


class _FakeVF:
    def __init__(self, series):
        self.series = series
        self.health = {k: _Health() for k in series}

    def usable(self, name):
        return name in self.series

    def get(self, name):
        return self.series.get(name)


def _inputs(n=400):
    rng = np.random.default_rng(7)
    idx = pd.bdate_range("2024-01-01", periods=n)
    walk = lambda base, s: pd.Series(base * np.exp(np.cumsum(rng.normal(0, s, n))), index=idx)  # noqa: E731
    vix = walk(16, 0.06)
    series = {"VIX": vix, "VIX9D": vix * 0.97, "VIX3M": vix * 1.05, "SKEW": walk(140, 0.02),
              "VVIX": walk(95, 0.04), "OVX": walk(35, 0.05), "GVZ": walk(17, 0.04),
              "MOVE": walk(100, 0.04), "VXN": vix * 1.2 + rng.normal(0, 0.5, n)}
    market = pd.DataFrame({"spy": walk(450, 0.01), "agg": walk(98, 0.003),
                           "spy_vol": pd.Series(rng.integers(5e7, 9e7, n).astype(float), index=idx)})
    return _FakeVF(series), market


def test_export_is_the_chart_and_the_board_on_every_row():
    import routers.tail_risk as tr

    vf, market = _inputs()
    vol, _ = tr._vol_signal_frame(vf)
    flow, _ = tr._flow_signal_frame(market)
    table = tr.signal_history_table(vol, flow, tr._evidence_frame(vf, market))
    chart = tr._history_rows(tr._combined_frame(vol, flow).tail(90))
    tail = table.tail(90)
    assert list(tail.index) == [r["date"] for r in chart]
    assert list(tail["signals_on"]) == [r["signals_on"] for r in chart]
    assert list(tail["alert_dimensions"]) == [r["alert_dimensions"] for r in chart]
    # the last row is the board's "now": each signal's last state
    last = table.iloc[-1]
    for sig in vol.columns:
        assert last[sig] == int(bool(vol[sig].iloc[-1])), sig


def test_export_states_follow_their_readings_and_warmup_is_unknown():
    import routers.tail_risk as tr

    vf, market = _inputs()
    vol, _ = tr._vol_signal_frame(vf)
    flow, _ = tr._flow_signal_frame(market)
    t = tr.signal_history_table(vol, flow, tr._evidence_frame(vf, market))
    known = t.dropna(subset=["OVX_z63"])
    assert (known["ovx_spike"] == (known["OVX_z63"] > 1.5).astype(int)).all()
    sk = t.dropna(subset=["SKEW"])
    assert (sk["skew_elevated"] == (sk["SKEW"] > 145).astype(int)).all()
    rsi = t.dropna(subset=["SPY_RSI14"])
    assert (rsi["rsi_oversold"] == (rsi["SPY_RSI14"] < 35).astype(int)).all()
    # z63 is not defined on the first rows: unknown, not off
    assert t["ovx_spike"].iloc[:30].isna().all()
    assert t["layer_a_bearish"].iloc[:200].isna().all()
    # vix_level is known in its z20 warm-up only when VIX > 30 decides it alone
    warm = t[t["VIX_z20"].isna()]
    assert (warm["vix_level"].isna() == ~(warm["VIX"] > 30)).all()
