"""
Backtest engine: precision, recall, F1, median lead time per signal.

Logic:
  For each signal S and lookahead window W:
    Precision = P(fat tail within W days | signal fired)
    Recall    = P(signal fired within W days before | fat tail occurred)
    Lead time = median days between signal and event (where signal preceded event)
"""
import numpy as np
import pandas as pd
from typing import NamedTuple
from config import CRASH_LEVELS, LOOKAHEAD_DAYS


class SignalMetrics(NamedTuple):
    signal: str
    level: str
    lookahead: int
    n_signals: int       # total signal fires
    n_events: int        # total fat tail events
    tp: int              # true positives
    precision: float     # tp / n_signals
    recall: float        # tp / n_events
    f1: float
    lead_med: float      # median days (signal → event), nan if none
    random_precision: float  # baseline = event_rate * lookahead / trading_days


def define_events(spy: pd.Series) -> dict[str, pd.Series]:
    """
    Returns dict level→Series[bool] True on fat tail event days.
    """
    daily_ret = spy.pct_change()
    events = {}
    for level, threshold in CRASH_LEVELS.items():
        events[level] = (daily_ret <= threshold).rename(f"event_{level}")
    return events


def _compute_metrics(
    signal: pd.Series,
    event: pd.Series,
    lookahead: int,
) -> tuple[int, int, int, float]:
    """
    Returns (n_signals, tp, precision, lead_med_days).
    TP: signal fired on day T, event occurred on day T+1..T+lookahead.
    """
    sig_dates   = signal.index[signal]
    event_dates = set(event.index[event])

    n_signals  = len(sig_dates)
    leads      = []

    for d in sig_dates:
        loc = signal.index.get_loc(d)
        window = signal.index[loc + 1: loc + 1 + lookahead]
        for future in window:
            if future in event_dates:
                delta = (future - d).days
                leads.append(delta)
                break  # count once per signal fire

    tp        = len(leads)
    precision = tp / n_signals if n_signals > 0 else 0.0
    lead_med  = float(np.median(leads)) if leads else float("nan")
    return n_signals, tp, precision, lead_med


def _compute_recall(
    signal: pd.Series,
    event: pd.Series,
    lookahead: int,
) -> tuple[int, int, float]:
    """
    Returns (n_events, tp_recall, recall).
    TP: event on day T, signal fired on day T-lookahead..T-1.
    """
    event_dates = event.index[event]
    sig_set     = set(signal.index[signal])

    n_events = len(event_dates)
    caught   = 0

    for d in event_dates:
        loc = event.index.get_loc(d)
        window = event.index[max(0, loc - lookahead): loc]
        if any(prior in sig_set for prior in window):
            caught += 1

    recall = caught / n_events if n_events > 0 else 0.0
    return n_events, caught, recall


def run_period(
    signals_df: pd.DataFrame,
    spy: pd.Series,
    label: str,
) -> pd.DataFrame:
    """
    Run full backtest for one period.
    Returns DataFrame with one row per (signal × level × lookahead).
    """
    events = define_events(spy.reindex(signals_df.index).ffill())
    trading_days = len(signals_df)

    rows = []
    for sig_col in signals_df.columns:
        signal = signals_df[sig_col]
        for level, event in events.items():
            event = event.reindex(signal.index).fillna(False)
            event_rate = event.mean()

            for look in LOOKAHEAD_DAYS:
                n_sig, tp_prec, precision, lead_med = _compute_metrics(signal, event, look)
                n_ev,  tp_rec,  recall              = _compute_recall(signal, event, look)

                f1 = (
                    2 * precision * recall / (precision + recall)
                    if precision + recall > 0 else 0.0
                )
                random_prec = 1 - (1 - event_rate) ** look

                rows.append(SignalMetrics(
                    signal=sig_col,
                    level=level,
                    lookahead=look,
                    n_signals=n_sig,
                    n_events=n_ev,
                    tp=tp_prec,
                    precision=precision,
                    recall=recall,
                    f1=f1,
                    lead_med=lead_med,
                    random_precision=random_prec,
                ))

    df = pd.DataFrame(rows)
    df.insert(0, "period", label)
    return df


def current_status(signals_df: pd.DataFrame, n_days: int = 5) -> pd.DataFrame:
    """Return last N days of signal states for forward-test dashboard."""
    last = signals_df.tail(n_days).copy()
    last.index = last.index.strftime("%Y-%m-%d")
    return last.T
