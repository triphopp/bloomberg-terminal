"""
Feature engineering for the per-symbol Market State model.

The point of this module is to turn OHLCV into a SMALL set of numbers that span
the four axes the dashboard reports — direction, trend strength, momentum
change, volatility, participation — without feeding the model five copies of the
same information.

── Why a fixed feature set rather than per-symbol selection ──────────────────

Selecting features per symbol would make the fitted states incomparable between
symbols (state 2 on AMD would mean something different from state 2 on MSFT) and
unstable as the window rolls. So the model set is fixed by design and the
redundancy CHECK is reported instead of acted on: `redundancy_report()` computes
every candidate the brief mentions — ATR%, Bollinger width, high-low range, ADX,
RSI, MACD histogram, volume change — and shows how each correlates with what is
already in the model. If the numbers ever say a rejected candidate carries
independent information, that is an argument to add it, made from data rather
than from belief.

── The five model features ───────────────────────────────────────────────────

    ret_z      20-bar log return in units of its own σ        — direction
    slope_z    t-statistic of an OLS fit to 60 bars of log price — trend strength
    mom_delta  change in 20-bar momentum over the last 10 bars — momentum derivative
    rvol_z     log realized vol vs its own 252-bar distribution — volatility level
    vol_z      robust log-volume z-score                       — participation

`slope_z` stands in for ADX: it is continuous, signed, and already scaled by how
well the trend line fits, which is the thing ADX proxies for. Measured on real
data the two only correlate ≈0.4-0.6, so this is a choice about which
representation of the axis to keep, not a claim that ADX is a duplicate — see
REJECTED_DOC. `vol_z` uses the same median/MAD-on-ln(V) construction as
`components/bloomberg/lib/volume-stats.ts` and `alerts/operands._vol_z_series`,
so "abnormal volume" means one thing across the whole terminal.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Bars each feature needs before it produces anything. The longest one sets how
# much history is burned before the model sees its first observation.
RET_WINDOW = 20
SLOPE_WINDOW = 60
MOM_WINDOW = 20
MOM_LAG = 10
RVOL_WINDOW = 20
RVOL_RANK_WINDOW = 252
VOL_LOOKBACK = 60
ATR_WINDOW = 14
BB_WINDOW = 20
ADX_WINDOW = 14
RSI_WINDOW = 14

MODEL_FEATURES = ["ret_z", "slope_z", "mom_delta", "rvol_z", "vol_z"]

FEATURE_DOC = {
    "ret_z": "20-bar log return ÷ its own σ — where price has gone",
    "slope_z": "t-stat of an OLS line through 60 bars of log price — how cleanly it is trending",
    "mom_delta": "20-bar momentum now minus 20-bar momentum 10 bars ago — is momentum building or fading",
    "rvol_z": "log realized vol vs its own 252-bar distribution — how loud the tape is",
    "vol_z": "robust log-volume z-score (median/MAD on ln V) — how many people are involved",
}

# Candidates computed for the redundancy report but kept out of the model.
#
# Two different reasons, and the report shows which applies by printing each
# one's measured correlation against the model set:
#
#   MEASURED REDUNDANT — |r| ≥ 0.80 against a feature already in the model, on
#     real data. RSI↔ret_z ≈ 0.88, MACD-hist↔mom_delta ≈ 0.82, vol_chg↔vol_z
#     ≈ 0.85. These carry almost nothing the model does not already have.
#
#   SAME AXIS, KEPT OUT FOR PARSIMONY — correlated but NOT redundant: ATR%↔rvol_z
#     ≈ 0.60-0.74, Bollinger width↔rvol_z ≈ 0.55, ADX↔|slope_z| ≈ 0.42-0.63
#     (measured on AMD / MSFT / KO). They are excluded because a 4-state
#     full-covariance Gaussian HMM already estimates 4×15 = 60 covariance
#     parameters on five features, and each extra dimension costs fit variance
#     for a third reading of an axis that is already represented — not because
#     the data says they are duplicates. That is a judgement about model size,
#     and the DIAGNOSTICS tab prints the numbers so it can be argued with.
REJECTED_DOC = {
    "atr_pct": "ATR(14)/close — volatility axis, already carried by rvol_z (not redundant: |r| ≈ 0.6-0.74)",
    "bb_width": "Bollinger width (20, 2σ) — volatility axis again (|r| ≈ 0.55 vs rvol_z)",
    "hl_range": "mean (high−low)/close over 20 bars — volatility axis, and ≈0.91 with ATR%",
    "adx": "ADX(14) — trend strength unsigned; slope_z measures it continuously and with a sign (|r| ≈ 0.4-0.6 vs |slope_z|)",
    "rsi": "RSI(14) — measured redundant with ret_z (|r| ≈ 0.88)",
    "macd_hist": "MACD(12,26,9) histogram ÷ close — measured redundant with mom_delta (|r| ≈ 0.82)",
    "vol_chg": "ln(V / SMA(V,20)) — measured redundant with vol_z (|r| ≈ 0.85); the mean baseline is also the one volume-stats.ts rejects",
}

# |r| at or above this counts as redundant in the report.
REDUNDANT_AT = 0.80

# The volume z-score constants are shared with lib/volume-stats.ts — changing
# one without the other makes "abnormal volume" mean two things in one product.
_MIN_SAMPLES = 8
_MAD_TO_SIGMA = 1.4826
_MIN_SIGMA = 1e-6


@dataclass
class FeatureSet:
    """Model matrix plus everything needed to explain and audit it."""

    frame: pd.DataFrame          # model features only, NaN rows dropped
    candidates: pd.DataFrame     # every candidate, same index as `frame`
    used: list[str]              # model feature names actually present
    dropped: list[str]           # model features dropped (all-NaN, e.g. no volume)
    bars_in: int                 # OHLCV rows handed in
    bars_out: int                # rows that survived the warm-up


# ── Primitives ───────────────────────────────────────────────────────────────

def _rolling_slope_t(log_px: pd.Series, window: int) -> pd.Series:
    """t-statistic of the OLS slope of `log_px` against bar index.

    The t-stat rather than the slope itself: a slope of 0.001/bar means something
    completely different on a quiet utility than on a biotech, and dividing by
    the standard error of the fit makes the two comparable. It also penalises a
    trend line that the data scatters around, which is exactly the "strength"
    half of the reading.
    """
    n = window
    x = np.arange(n, dtype=float)
    x_centred = x - x.mean()
    sxx = float((x_centred**2).sum())

    def _t(vals: np.ndarray) -> float:
        y = vals
        if not np.isfinite(y).all():
            return np.nan
        beta = float(x_centred @ (y - y.mean()) / sxx)
        resid = y - (y.mean() + beta * x_centred)
        dof = n - 2
        s2 = float(resid @ resid) / dof
        if s2 <= 0:
            return 0.0
        se = np.sqrt(s2 / sxx)
        return beta / se if se > 0 else 0.0

    return log_px.rolling(n).apply(_t, raw=True)


def _robust_volume_z(volume: pd.Series, lookback: int = VOL_LOOKBACK) -> pd.Series:
    """Median/MAD z-score of ln(volume) over the prior `lookback` bars.

    Mirrors volumeZ() in lib/volume-stats.ts for daily bars — see that file for
    why the baseline is a median of logs and not a mean of levels.
    """
    v = volume.to_numpy(dtype=float)
    out = np.full(len(v), np.nan)
    logs = np.where(v > 0, np.log(np.where(v > 0, v, 1.0)), np.nan)

    for i in range(len(v)):
        if not v[i] > 0:
            continue
        window = logs[max(0, i - lookback):i]
        window = window[~np.isnan(window)]
        if len(window) < _MIN_SAMPLES:
            continue
        centre = float(np.median(window))
        sigma = _MAD_TO_SIGMA * float(np.median(np.abs(window - centre)))
        if not sigma >= _MIN_SIGMA:
            sigma = float(np.std(window, ddof=1)) if len(window) > 1 else 0.0
        if not sigma >= _MIN_SIGMA:
            continue
        out[i] = (logs[i] - centre) / sigma
    return pd.Series(out, index=volume.index)


def _wilder_rma(values: pd.Series, period: int) -> pd.Series:
    """Wilder's smoothing — the average ATR, ADX and RSI are all defined on."""
    return values.ewm(alpha=1.0 / period, adjust=False).mean()


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)
    return _wilder_rma(tr, period)


def _adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
    up = high.diff()
    down = -low.diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    atr = _atr(high, low, close, period)
    plus_di = 100 * _wilder_rma(pd.Series(plus_dm, index=high.index), period) / atr
    minus_di = 100 * _wilder_rma(pd.Series(minus_dm, index=high.index), period) / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return _wilder_rma(dx, period)


def _rsi(close: pd.Series, period: int) -> pd.Series:
    delta = close.diff()
    gain = _wilder_rma(delta.clip(lower=0), period)
    loss = _wilder_rma((-delta).clip(lower=0), period)
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


# ── Feature construction ─────────────────────────────────────────────────────

def build_features(ohlcv: pd.DataFrame) -> FeatureSet:
    """OHLCV (columns open/high/low/close/volume, oldest first) → FeatureSet.

    Every feature is built from data at or before its own bar. Nothing here uses
    a centred window or a full-sample statistic, because a feature that peeks
    makes the whole causal-labelling exercise downstream pointless.
    """
    df = ohlcv.copy()
    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    volume = df["volume"].astype(float) if "volume" in df else pd.Series(np.nan, index=df.index)

    log_px = np.log(close.where(close > 0))
    log_ret = log_px.diff()

    daily_sigma = log_ret.rolling(RVOL_RANK_WINDOW, min_periods=60).std()

    cand = pd.DataFrame(index=df.index)

    # ── model features ──
    # Scaled by the σ of a 20-bar sum, so "2" means the same thing on any symbol.
    cand["ret_z"] = (log_px - log_px.shift(RET_WINDOW)) / (daily_sigma * np.sqrt(RET_WINDOW))
    cand["slope_z"] = _rolling_slope_t(log_px, SLOPE_WINDOW)

    roc = log_px - log_px.shift(MOM_WINDOW)
    cand["mom_delta"] = (roc - roc.shift(MOM_LAG)) / (daily_sigma * np.sqrt(MOM_WINDOW))

    rvol = log_ret.rolling(RVOL_WINDOW).std() * np.sqrt(252)
    log_rvol = np.log(rvol.where(rvol > 0))
    cand["rvol_z"] = (
        log_rvol - log_rvol.rolling(RVOL_RANK_WINDOW, min_periods=60).mean()
    ) / log_rvol.rolling(RVOL_RANK_WINDOW, min_periods=60).std()

    cand["vol_z"] = _robust_volume_z(volume)

    # ── candidates kept out of the model, computed for the report ──
    atr = _atr(high, low, close, ATR_WINDOW)
    cand["atr_pct"] = atr / close
    ma = close.rolling(BB_WINDOW).mean()
    sd = close.rolling(BB_WINDOW).std(ddof=0)
    cand["bb_width"] = (4 * sd) / ma
    cand["hl_range"] = ((high - low) / close).rolling(BB_WINDOW).mean()
    cand["adx"] = _adx(high, low, close, ADX_WINDOW)
    cand["rsi"] = _rsi(close, RSI_WINDOW)
    ema_fast = close.ewm(span=12, adjust=False).mean()
    ema_slow = close.ewm(span=26, adjust=False).mean()
    macd = ema_fast - ema_slow
    cand["macd_hist"] = (macd - macd.ewm(span=9, adjust=False).mean()) / close
    vol_ma = volume.rolling(BB_WINDOW).mean()
    cand["vol_chg"] = np.log(volume.where(volume > 0) / vol_ma.where(vol_ma > 0))

    cand = cand.replace([np.inf, -np.inf], np.nan)

    # A symbol that reports no volume at all (an index, a yield, an FX cross)
    # loses the participation axis rather than the whole panel: dropping the
    # column keeps four honest features, while keeping it would drop every row.
    dropped = [f for f in MODEL_FEATURES if cand[f].notna().sum() == 0]
    used = [f for f in MODEL_FEATURES if f not in dropped]

    frame = cand[used].dropna()
    candidates = cand.loc[frame.index]

    return FeatureSet(
        frame=frame,
        candidates=candidates,
        used=used,
        dropped=dropped,
        bars_in=len(df),
        bars_out=len(frame),
    )


# ── Redundancy audit ─────────────────────────────────────────────────────────

def _vif(frame: pd.DataFrame) -> dict[str, float]:
    """Variance inflation factor per column: 1/(1−R²) of it on the others.

    Reported rather than enforced. VIF > 5 says a feature is largely a linear
    combination of its neighbours, which for a Gaussian HMM shows up as a
    near-singular covariance — the practical symptom of feeding the model the
    same information twice.
    """
    out: dict[str, float] = {}
    cols = list(frame.columns)
    if len(cols) < 2:
        return {c: 1.0 for c in cols}
    X_all = frame.to_numpy(dtype=float)
    for i, col in enumerate(cols):
        y = X_all[:, i]
        X = np.delete(X_all, i, axis=1)
        X = np.column_stack([np.ones(len(X)), X])
        try:
            beta, *_ = np.linalg.lstsq(X, y, rcond=None)
            resid = y - X @ beta
            ss_res = float(resid @ resid)
            ss_tot = float(((y - y.mean()) ** 2).sum())
            r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
            out[col] = float(1 / (1 - r2)) if r2 < 1 - 1e-9 else float("inf")
        except np.linalg.LinAlgError:
            out[col] = float("nan")
    return out


def redundancy_report(fs: FeatureSet) -> dict:
    """Correlation matrix, redundant pairs and VIF — the audit the brief asks for.

    Runs on every candidate, not just the model set, so the report answers both
    "is what we feed the model redundant with itself" and "is something we left
    out actually carrying independent information".
    """
    cand = fs.candidates.dropna()
    if len(cand) < 30:
        return {"status": "insufficient", "bars": int(len(cand))}

    corr = cand.corr()
    names = list(corr.columns)

    pairs = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            r = float(corr.loc[a, b])
            if abs(r) >= REDUNDANT_AT:
                pairs.append(
                    {
                        "a": a,
                        "b": b,
                        "r": round(r, 3),
                        # Only a pair where BOTH sides are in the model is a
                        # problem to fix; the rest is the evidence for why the
                        # rejected candidate stays rejected.
                        "both_in_model": a in fs.used and b in fs.used,
                    }
                )
    pairs.sort(key=lambda p: -abs(p["r"]))

    # For every candidate NOT in the model: its strongest tie to something that
    # IS. This is the number that decides whether leaving it out was safe, so it
    # is reported per-feature rather than buried in the full matrix.
    rejected_vs_model = []
    for name in names:
        if name in fs.used:
            continue
        ties = [(abs(float(corr.loc[name, m])), m, float(corr.loc[name, m])) for m in fs.used]
        best = max(ties)
        rejected_vs_model.append(
            {
                "feature": name,
                "closest_model_feature": best[1],
                "r": round(best[2], 3),
                "verdict": "redundant" if best[0] >= REDUNDANT_AT else "same axis, kept out for parsimony",
                "reason": REJECTED_DOC.get(name, ""),
            }
        )
    rejected_vs_model.sort(key=lambda d: -abs(d["r"]))

    model_corr = corr.loc[fs.used, fs.used]
    return {
        "status": "ok",
        "bars": int(len(cand)),
        "threshold": REDUNDANT_AT,
        "model_features": fs.used,
        "dropped_features": fs.dropped,
        "feature_doc": {k: v for k, v in FEATURE_DOC.items() if k in fs.used},
        "rejected_doc": REJECTED_DOC,
        "matrix": {
            "names": names,
            "values": [[round(float(corr.loc[a, b]), 3) for b in names] for a in names],
        },
        "model_matrix": {
            "names": fs.used,
            "values": [
                [round(float(model_corr.loc[a, b]), 3) for b in fs.used] for a in fs.used
            ],
        },
        "redundant_pairs": pairs,
        "rejected_vs_model": rejected_vs_model,
        "vif": {k: (None if not np.isfinite(v) else round(v, 2)) for k, v in _vif(cand[fs.used]).items()},
        "max_model_abs_corr": round(
            float(
                np.abs(model_corr.to_numpy()[np.triu_indices(len(fs.used), k=1)]).max()
                if len(fs.used) > 1
                else 0.0
            ),
            3,
        ),
    }
