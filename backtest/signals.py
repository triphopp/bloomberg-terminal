"""
Full signal suite — mirrors every detection mechanism in the project.

Groups:
  1  VIX-based          (backwardation, spike, momentum)
  2  Credit spreads     (HY, IG, EM HY, TED — crisis.py thresholds + z-score)
  3  Financial stress   (STL FSI, NFCI — crisis.py)
  4  Yield curve        (10Y-2Y, 10Y-3M inversions)
  5  Fear & Greed       (synthetic composite — fear_greed.py)
  6  Sector regime      (convergent correlation — regime.py)
  7  Equity technicals  (RSI oversold, price z-score)
  8  Allocation Layer A (SPY vs AGG z-score — layer_a.py)
  9  Crisis composite   (weighted score — crisis.py /composite)
 10  Volume/flow        (SPY volume surge)
 11  Cross-asset        (safe haven, correlation velocity)
 12  Composite          (3+ signals active simultaneously)
"""
import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings("ignore", category=FutureWarning)

from config import (
    # G1
    VIX_ZSCORE_WINDOW, VIX_ZSCORE_THRESHOLD,
    VIX_MOMENTUM_DAYS, VIX_MOMENTUM_PCT,
    # G2
    HY_THRESHOLD, IG_THRESHOLD, EM_HY_THRESHOLD, TED_THRESHOLD,
    HY_ZSCORE_WINDOW, HY_ZSCORE_THRESHOLD,
    # G3
    STL_FSI_THRESHOLD, NFCI_THRESHOLD,
    # G4
    YC_INVERSION_THRESHOLD,
    # G5
    FG_EXTREME_FEAR, FG_FEAR_ZONE, FG_ROLLING_WINDOW,
    # G6
    SECTOR_CORR_WINDOW, SECTOR_CONVERGENT_THRESH, SECTOR_ETFS,
    # G7
    RSI_OVERSOLD_THRESHOLD, RSI_PERIOD,
    PRICE_ZSCORE_WINDOW, PRICE_ZSCORE_THRESHOLD,
    # G8
    LAYER_A_LOOKBACK, LAYER_A_Z_WINDOW, LAYER_A_BEARISH,
    # G9
    CRISIS_COMPOSITE_RED,
    # G10
    VOLUME_WINDOW, VOLUME_ZSCORE_THRESH,
    # G11
    CORR_WINDOW, CORR_VELOCITY_DAYS, CORR_VELOCITY_THRESH,
    # composite
    COMPOSITE_MIN_SIGNALS,
)


# ─── Utility ──────────────────────────────────────────────────────────────────

def _zscore_signal(series: pd.Series, window: int, threshold: float,
                   direction: str = "above") -> pd.Series:
    mu = series.rolling(window, min_periods=window // 2).mean()
    sd = series.rolling(window, min_periods=window // 2).std()
    z  = (series - mu) / sd.replace(0, np.nan)
    if direction == "above":
        return (z > threshold).rename(series.name)
    return (z < threshold).rename(series.name)


def _rsi(prices: pd.Series, period: int = 14) -> pd.Series:
    delta = prices.diff()
    gain  = delta.clip(lower=0).rolling(period, min_periods=period).mean()
    loss  = (-delta.clip(upper=0)).rolling(period, min_periods=period).mean()
    rs    = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def _pct_rank_series(s: pd.Series, window: int) -> pd.Series:
    """Rolling percentile rank 0-100 (matching fear_greed.py methodology)."""
    return s.rolling(window, min_periods=window // 4).apply(
        lambda x: float((x[-1] > x[:-1]).mean() * 100), raw=True
    )


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 1 — VIX-based
# ══════════════════════════════════════════════════════════════════════════════

def sig_vix_backwardation(vix: pd.Series, vix9d: pd.Series, vix3m: pd.Series) -> pd.Series:
    """Front inversion (VIX9D > VIX) OR back inversion (VIX > VIX3M)."""
    front = (vix9d > vix)
    back  = (vix   > vix3m)
    return (front | back).rename("g1_vix_backwardation")


def sig_vix_spike(vix: pd.Series) -> pd.Series:
    """VIX z-score > 1.5 OR VIX > 30 (crisis.py threshold)."""
    z_sig  = _zscore_signal(vix, VIX_ZSCORE_WINDOW, VIX_ZSCORE_THRESHOLD)
    abs_sig = (vix > 30)
    return (z_sig | abs_sig).rename("g1_vix_spike")


def sig_vix_momentum(vix: pd.Series) -> pd.Series:
    """VIX rose ≥ 20% in 5 days."""
    return (vix.pct_change(VIX_MOMENTUM_DAYS) >= VIX_MOMENTUM_PCT).rename("g1_vix_momentum")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 2 — Credit Spreads
# ══════════════════════════════════════════════════════════════════════════════

def sig_hy_static(hy: pd.Series) -> pd.Series:
    """HY OAS > 5% (crisis.py static threshold)."""
    if hy.empty: return pd.Series(dtype=bool, name="g2_hy_static")
    return (hy > HY_THRESHOLD).rename("g2_hy_static")


def sig_hy_zscore(hy: pd.Series) -> pd.Series:
    """HY OAS rolling z-score > 1.5 (regime-aware)."""
    if hy.empty: return pd.Series(dtype=bool, name="g2_hy_zscore")
    return _zscore_signal(hy, HY_ZSCORE_WINDOW, HY_ZSCORE_THRESHOLD).rename("g2_hy_zscore")


def sig_ig_spread(ig: pd.Series) -> pd.Series:
    """IG OAS > 2% (crisis.py threshold)."""
    if ig.empty: return pd.Series(dtype=bool, name="g2_ig_static")
    return (ig > IG_THRESHOLD).rename("g2_ig_static")


def sig_em_hy(em_hy: pd.Series) -> pd.Series:
    """EM HY OAS > 6% (crisis.py threshold)."""
    if em_hy.empty: return pd.Series(dtype=bool, name="g2_em_hy")
    return (em_hy > EM_HY_THRESHOLD).rename("g2_em_hy")


def sig_ted(ted: pd.Series) -> pd.Series:
    """TED spread > 1% (crisis.py threshold). Discontinued Dec 2022."""
    if ted.empty: return pd.Series(dtype=bool, name="g2_ted")
    return (ted > TED_THRESHOLD).rename("g2_ted")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 3 — Financial Stress Indices
# ══════════════════════════════════════════════════════════════════════════════

def sig_stl_fsi(fsi: pd.Series) -> pd.Series:
    """STL Stress Index > 0 (crisis.py: 'above 0 = stress')."""
    if fsi.empty: return pd.Series(dtype=bool, name="g3_stl_fsi")
    return (fsi > STL_FSI_THRESHOLD).rename("g3_stl_fsi")


def sig_nfci(nfci: pd.Series) -> pd.Series:
    """Chicago NFCI > 0 (crisis.py: 'above 0 = tighter conditions')."""
    if nfci.empty: return pd.Series(dtype=bool, name="g3_nfci")
    return (nfci > NFCI_THRESHOLD).rename("g3_nfci")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 4 — Yield Curve
# ══════════════════════════════════════════════════════════════════════════════

def sig_yc_10y2y(yc: pd.Series) -> pd.Series:
    """10Y-2Y spread < 0 = inverted (crisis.py trigger)."""
    if yc.empty: return pd.Series(dtype=bool, name="g4_yc_10y2y")
    return (yc < YC_INVERSION_THRESHOLD).rename("g4_yc_10y2y")


def sig_yc_10y3m(yc: pd.Series) -> pd.Series:
    """10Y-3M spread < 0 = inverted (crisis.py trigger)."""
    if yc.empty: return pd.Series(dtype=bool, name="g4_yc_10y3m")
    return (yc < YC_INVERSION_THRESHOLD).rename("g4_yc_10y3m")


def sig_yc_tnx_irx(tnx: pd.Series, irx: pd.Series) -> pd.Series:
    """10Y (^TNX) - 3M T-bill (^IRX) computed from yfinance when FRED unavailable."""
    if tnx.empty or irx.empty: return pd.Series(dtype=bool, name="g4_yc_live")
    spread = tnx - irx
    return (spread < 0).rename("g4_yc_live")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 5 — Fear & Greed Synthetic (matches fear_greed.py exactly)
# ══════════════════════════════════════════════════════════════════════════════

def _compute_fg_series(
    vix: pd.Series,
    spy: pd.Series,
    tlt: pd.Series,
    hyg: pd.Series,
    lqd: pd.Series,
    rsp: pd.Series,
    window: int = FG_ROLLING_WINDOW,
) -> pd.Series:
    """
    Synthetic Fear & Greed 0-100 (matching fear_greed.py).
    Components:
      c1: VIX percentile inverted (25%)
      c2: SPY momentum vs 125d SMA (25%)
      c3: SPY vs TLT 20d relative return (20%)
      c4: HYG/LQD ratio (15%)
      c5: RSP/SPY breadth (15%)
    """
    W = window

    # c1: low VIX = greed
    c1 = 100 - _pct_rank_series(vix, W)

    # c2: SPY momentum vs 125d SMA
    sma125 = spy.rolling(125, min_periods=63).mean()
    mom = (spy - sma125) / sma125 * 100
    c2 = _pct_rank_series(mom, W)

    # c3: SPY vs TLT 20d relative return
    diff = (spy.pct_change(20) - tlt.pct_change(20)) * 100
    c3 = _pct_rank_series(diff, W)

    # c4: HYG/LQD junk bond demand
    c4 = _pct_rank_series(hyg / lqd.replace(0, np.nan), W)

    # c5: RSP/SPY market breadth
    c5 = _pct_rank_series(rsp / spy.replace(0, np.nan), W)

    composite = (
        c1.fillna(50) * 0.25 +
        c2.fillna(50) * 0.25 +
        c3.fillna(50) * 0.20 +
        c4.fillna(50) * 0.15 +
        c5.fillna(50) * 0.15
    ).rolling(3, min_periods=1).mean()

    return composite.rename("fear_greed_synthetic")


def sig_fg_extreme_fear(
    vix: pd.Series, spy: pd.Series, tlt: pd.Series,
    hyg: pd.Series, lqd: pd.Series, rsp: pd.Series,
) -> pd.Series:
    """Fear & Greed < 25 = Extreme Fear (matches fear_greed.py zone_map)."""
    fg = _compute_fg_series(vix, spy, tlt, hyg, lqd, rsp)
    return (fg < FG_EXTREME_FEAR).rename("g5_fg_extreme_fear")


def sig_fg_fear_zone(
    vix: pd.Series, spy: pd.Series, tlt: pd.Series,
    hyg: pd.Series, lqd: pd.Series, rsp: pd.Series,
) -> pd.Series:
    """Fear & Greed < 45 = Fear zone (matches fear_greed.py)."""
    fg = _compute_fg_series(vix, spy, tlt, hyg, lqd, rsp)
    return (fg < FG_FEAR_ZONE).rename("g5_fg_fear_zone")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 6 — Sector Regime (matches regime.py CONVERGENT logic)
# ══════════════════════════════════════════════════════════════════════════════

def sig_sector_convergent(sector_data: dict[str, pd.Series]) -> pd.Series:
    """
    Average pairwise rolling correlation of 11 sector ETFs > 0.65.
    Mirrors regime.py _heuristic_corr_label 'CONVERGENT' threshold.
    """
    available = {k: v for k, v in sector_data.items() if not v.empty}
    if len(available) < 5:
        return pd.Series(dtype=bool, name="g6_sector_convergent")

    rets = pd.DataFrame({k: v.pct_change() for k, v in available.items()}).dropna(how="all")
    pairs = [(a, b) for i, a in enumerate(rets.columns)
             for b in list(rets.columns)[i + 1:]]

    corr_df = pd.DataFrame(index=rets.index)
    for a, b in pairs:
        corr_df[f"{a}_{b}"] = rets[a].rolling(SECTOR_CORR_WINDOW, min_periods=10).corr(rets[b])

    avg_corr = corr_df.mean(axis=1)
    return (avg_corr > SECTOR_CONVERGENT_THRESH).rename("g6_sector_convergent")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 7 — Equity Technicals
# ══════════════════════════════════════════════════════════════════════════════

def sig_rsi_oversold(spy: pd.Series) -> pd.Series:
    """SPY RSI < 35 (oversold / panic)."""
    rsi = _rsi(spy, RSI_PERIOD)
    return (rsi < RSI_OVERSOLD_THRESHOLD).rename("g7_rsi_oversold")


def sig_price_zscore(spy: pd.Series) -> pd.Series:
    """
    SPY 20d RETURN z-score < -2 (extreme negative return vs recent history).
    Uses daily returns (stationary), NOT price levels (non-stationary/trending).
    Fix: previous version compared price levels → fired 93% of days.
    """
    returns = spy.pct_change()
    return _zscore_signal(
        returns, PRICE_ZSCORE_WINDOW, abs(PRICE_ZSCORE_THRESHOLD), "below"
    ).rename("g7_price_zscore")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 8 — Allocation Layer A (matches layer_a.py exactly)
# ══════════════════════════════════════════════════════════════════════════════

def sig_layer_a_bearish(spy: pd.Series, agg: pd.Series) -> pd.Series:
    """
    SPY vs AGG 20d relative return z-score < -0.5 → bearish (score = -1).
    Matches layer_a.py compute_layer_a() logic (no vol scaling for simplicity).
    """
    if spy.empty or agg.empty:
        return pd.Series(dtype=bool, name="g8_layer_a_bearish")

    spy_d = spy.pct_change()
    agg_d = agg.pct_change()
    rel   = spy_d - agg_d

    # 20d relative return
    rel_20d = spy.pct_change(LAYER_A_LOOKBACK) - agg.pct_change(LAYER_A_LOOKBACK)

    # Rolling z-score over 252d window
    mu    = rel.rolling(LAYER_A_Z_WINDOW, min_periods=60).mean()
    sigma = rel.rolling(LAYER_A_Z_WINDOW, min_periods=60).std()
    z     = (rel_20d - mu) / sigma.replace(0, np.nan)

    return (z < LAYER_A_BEARISH).rename("g8_layer_a_bearish")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 9 — Crisis Composite Score (matches crisis.py /composite)
# ══════════════════════════════════════════════════════════════════════════════

def _vix_score(vix: pd.Series) -> pd.Series:
    return (vix / 80 * 100).clip(upper=100)

def _hy_score_norm(hy: pd.Series) -> pd.Series:
    return (hy / 20 * 100).clip(upper=100)

def _yc_score_norm(yc: pd.Series) -> pd.Series:
    return yc.apply(lambda v:
        0.0 if v >= 1.0 else
        (1.0 - v) * 30 if v >= 0 else
        min(30 + abs(v) * 35, 100)
    )

def sig_crisis_composite(
    vix: pd.Series,
    hy: pd.Series,
    yc_10y2y: pd.Series,
) -> pd.Series:
    """
    Crisis composite score > 45 = RED (threshold fixed from 66).
    Weights: VIX 50%, HY 30%, YC 20%.
    CAPE removed (slow-moving, not crash predictor).
    YC included only as penalty when inverted, not as primary driver.
    """
    vs = _vix_score(vix).fillna(15)    # VIX 20 → score 25
    hs = _hy_score_norm(hy).fillna(10) if not hy.empty else pd.Series(10, index=vix.index)
    # YC: 0 if positive, rises as inversion deepens
    ys = _yc_score_norm(yc_10y2y).fillna(15) if not yc_10y2y.empty else pd.Series(15, index=vix.index)

    df = pd.DataFrame({"vs": vs, "hs": hs, "ys": ys})
    composite = df["vs"] * 0.50 + df["hs"] * 0.30 + df["ys"] * 0.20
    return (composite > CRISIS_COMPOSITE_RED).rename("g9_crisis_composite_red")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 10 — Volume / Flow
# ══════════════════════════════════════════════════════════════════════════════

def sig_volume_surge(spy_vol: pd.Series) -> pd.Series:
    """SPY volume z-score > 2 (rolling 63d)."""
    return _zscore_signal(spy_vol, VOLUME_WINDOW, VOLUME_ZSCORE_THRESH).rename("g10_volume_surge")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 11 — Cross-Asset
# ══════════════════════════════════════════════════════════════════════════════

def sig_safe_haven(spy: pd.Series, tlt: pd.Series, gld: pd.Series) -> pd.Series:
    """SPY down AND TLT up AND GLD up = classic risk-off flight."""
    spy_r = spy.pct_change()
    tlt_r = tlt.pct_change()
    gld_r = gld.pct_change()
    return ((spy_r < 0) & (tlt_r > 0) & (gld_r > 0)).rename("g11_safe_haven")


def sig_corr_velocity(
    spy: pd.Series, tlt: pd.Series, gld: pd.Series, hyg: pd.Series
) -> pd.Series:
    """Average cross-asset correlation rises > 0.10 in 5 days (convergence forming)."""
    rets = pd.concat([
        spy.pct_change().rename("SPY"),
        tlt.pct_change().rename("TLT"),
        gld.pct_change().rename("GLD"),
        hyg.pct_change().rename("HYG"),
    ], axis=1).dropna()

    pairs = [("SPY","TLT"),("SPY","GLD"),("SPY","HYG"),("TLT","GLD"),("TLT","HYG"),("GLD","HYG")]
    corr_df = pd.DataFrame(index=rets.index)
    for a, b in pairs:
        corr_df[f"{a}_{b}"] = rets[a].rolling(CORR_WINDOW, min_periods=10).corr(rets[b])

    avg_corr = corr_df.mean(axis=1)
    velocity = avg_corr.diff(CORR_VELOCITY_DAYS)
    return (velocity > CORR_VELOCITY_THRESH).rename("g11_corr_velocity")


# ══════════════════════════════════════════════════════════════════════════════
# GROUP 12 — Composite Gate
# ══════════════════════════════════════════════════════════════════════════════

def sig_composite(signals_df: pd.DataFrame) -> pd.Series:
    """N+ individual signals active simultaneously."""
    count = signals_df.sum(axis=1)
    return (count >= COMPOSITE_MIN_SIGNALS).rename("g12_composite")


# ══════════════════════════════════════════════════════════════════════════════
# Master builder
# ══════════════════════════════════════════════════════════════════════════════

def build_all(yf_data: dict, fred_data: dict) -> pd.DataFrame:
    """
    Compute all signals. Returns aligned bool DataFrame.
    Missing data → signal column omitted (not filled False, to avoid phantom signals).
    """
    from fetcher import close, volume

    # Pull series
    spy    = close(yf_data, "SPY")
    agg    = close(yf_data, "AGG")
    rsp    = close(yf_data, "RSP")
    tlt    = close(yf_data, "TLT")
    gld    = close(yf_data, "GLD")
    hyg    = close(yf_data, "HYG")
    lqd    = close(yf_data, "LQD")
    vix    = close(yf_data, "VIX")
    vix9d  = close(yf_data, "VIX9D")
    vix3m  = close(yf_data, "VIX3M")
    tnx    = close(yf_data, "TNX")
    irx    = close(yf_data, "IRX")
    spy_v  = volume(yf_data, "SPY")

    hy    = fred_data.get("HY_SPREAD", pd.Series(dtype=float))
    ig    = fred_data.get("IG_SPREAD",  pd.Series(dtype=float))
    em_hy = fred_data.get("EM_HY",      pd.Series(dtype=float))
    fsi   = fred_data.get("STL_FSI",    pd.Series(dtype=float))
    nfci  = fred_data.get("NFCI",       pd.Series(dtype=float))
    yc_2y = fred_data.get("YC_10Y2Y",   pd.Series(dtype=float))
    yc_3m = fred_data.get("YC_10Y3M",   pd.Series(dtype=float))

    # Sector ETFs for regime
    sector_data = {sym: close(yf_data, sym) for sym in SECTOR_ETFS}

    idx = spy.index

    def _ri(s: pd.Series) -> pd.Series:
        """Reindex + forward-fill to trading day index."""
        if s.empty: return s
        return s.reindex(idx).ffill(limit=5)

    agg   = _ri(agg);  rsp = _ri(rsp);   tlt = _ri(tlt)
    gld   = _ri(gld);  hyg = _ri(hyg);   lqd = _ri(lqd)
    vix   = _ri(vix);  vix9d = _ri(vix9d); vix3m = _ri(vix3m)
    tnx   = _ri(tnx);  irx = _ri(irx);   spy_v = _ri(spy_v)
    hy    = _ri(hy);   ig  = _ri(ig);    em_hy = _ri(em_hy)
    fsi   = _ri(fsi);  nfci= _ri(nfci)
    yc_2y = _ri(yc_2y); yc_3m = _ri(yc_3m)
    sector_data = {k: _ri(v) for k, v in sector_data.items()}

    sigs: dict[str, pd.Series] = {}

    def _add(name: str, fn, *args) -> None:
        try:
            s = fn(*args)
            if not s.empty and s.notna().any():
                sigs[name] = s.reindex(idx).fillna(False).astype(bool)
        except Exception as e:
            print(f"  [warn] {name} failed: {e}")

    # G1 VIX
    _add("g1_vix_backwardation", sig_vix_backwardation, vix, vix9d, vix3m)
    _add("g1_vix_spike",         sig_vix_spike,         vix)
    _add("g1_vix_momentum",      sig_vix_momentum,      vix)

    # G2 Credit spreads
    _add("g2_hy_static",  sig_hy_static,  hy)
    _add("g2_hy_zscore",  sig_hy_zscore,  hy)
    _add("g2_ig_static",  sig_ig_spread,  ig)
    _add("g2_em_hy",      sig_em_hy,      em_hy)
    # TED spread discontinued Dec 2022 — skip (no reliable full-period data)

    # G3 Financial stress
    _add("g3_stl_fsi",  sig_stl_fsi,  fsi)
    _add("g3_nfci",     sig_nfci,     nfci)

    # G4 Yield curve
    _add("g4_yc_10y2y", sig_yc_10y2y, yc_2y)
    _add("g4_yc_10y3m", sig_yc_10y3m, yc_3m)
    if yc_3m.isna().all():  # FRED unavailable → use live yfinance
        _add("g4_yc_live",  sig_yc_tnx_irx, tnx, irx)

    # G5 Fear & Greed synthetic
    _add("g5_fg_extreme_fear", sig_fg_extreme_fear, vix, spy, tlt, hyg, lqd, rsp)
    _add("g5_fg_fear_zone",    sig_fg_fear_zone,    vix, spy, tlt, hyg, lqd, rsp)

    # G6 Sector regime
    _add("g6_sector_convergent", sig_sector_convergent, sector_data)

    # G7 Equity technicals
    _add("g7_rsi_oversold",  sig_rsi_oversold,  spy)
    _add("g7_price_zscore",  sig_price_zscore,  spy)

    # G8 Allocation Layer A
    _add("g8_layer_a_bearish", sig_layer_a_bearish, spy, agg)

    # G9 Crisis composite
    _add("g9_crisis_composite_red", sig_crisis_composite, vix, hy, yc_2y)

    # G10 Volume
    _add("g10_volume_surge", sig_volume_surge, spy_v)

    # G11 Cross-asset
    if not (tlt.isna().all() or gld.isna().all()):
        _add("g11_safe_haven",    sig_safe_haven,    spy, tlt, gld)
    if not (tlt.isna().all() or gld.isna().all() or hyg.isna().all()):
        _add("g11_corr_velocity", sig_corr_velocity, spy, tlt, gld, hyg)

    df = pd.DataFrame(sigs).reindex(idx)
    df = df.infer_objects(copy=False).fillna(False).astype(bool)

    # G12 Composite gate — VALIDATED signals only (Tier 1 + selective Tier 2)
    # Excluded: g4_yc_* (wrong timescale, fires persistently), g7_price_zscore (fixed but
    # may still be noisy), g9_crisis_composite (threshold-sensitive).
    VALIDATED = [
        "g1_vix_backwardation", "g1_vix_spike", "g1_vix_momentum",
        "g5_fg_extreme_fear", "g6_sector_convergent",
        "g7_rsi_oversold", "g7_price_zscore",
        "g8_layer_a_bearish",
        "g10_volume_surge",
    ]
    valid_cols = [c for c in df.columns if c in VALIDATED]
    if len(valid_cols) >= COMPOSITE_MIN_SIGNALS:
        df["g12_composite"] = (df[valid_cols].sum(axis=1) >= COMPOSITE_MIN_SIGNALS)

    return df
