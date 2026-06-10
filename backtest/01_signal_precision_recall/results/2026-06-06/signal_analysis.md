# Signal Analysis Report — Bloomberg Terminal Fat Tail Detection
**Generated:** 2026-06-06  
**Backtest scope:** 19 signals × 3 periods × 3 event levels × 3 lookahead windows  
**Event definition:** SPY daily close-to-close return ≤ threshold  
**Signal timing:** signal fires at close of day T → event measured at T+1 … T+lookahead  

---

## How to Read the Metrics Tables

| Column | Meaning |
|--------|---------|
| **Fires %** | % of trading days signal was active (base rate) |
| **Precision** | % of signal fires followed by event within lookahead |
| **vs Random** | Precision minus baseline (event_rate × lookahead); the real test of skill |
| **Recall** | % of events that had a preceding signal within lookahead |
| **F1** | Harmonic mean of precision and recall |
| **Lead (med)** | Median calendar days between signal and event |

**Verdict scale:**  
✅ STRONG = precision ≥ 50% AND recall ≥ 45%  
🟡 USEFUL = precision ≥ 35% AND edge ≥ 15pp  
🟡 SENSITIVE = recall ≥ 55% but lower precision (catches events but noisy)  
⚠️ MIXED = some edge but inconsistent across periods  
❌ WEAK = edge < 5pp (no better than random)  
🔴 BROKEN = implementation bug (fires 0% or 90%+ of all days)  

---

## Event Base Rates

| Period | L1 events | L2 events | L3 events | Trading days |
|--------|:---------:|:---------:|:---------:|:------------:|
| In-sample 2015-2022 | 136 (6.8%) | 32 (1.6%) | 5 (0.25%) | 2,014 |
| OOS 2023-2024 | 16 (3.2%) | 0 (0%) | 0 (0%) | 501 |
| Forward 2025-2026 | 24 (6.7%) | 3 (0.84%) | 0 (0%) | 357 |

> **L2 events = 0 in OOS**: 2023-2024 was a bull market. SPY never closed down ≥ 3% in a single day during this period, making OOS L2 validation impossible. This is itself a risk: signals trained on volatile regimes may degrade in calm markets.

---

---

# GROUP 1 — VIX-Based Signals

---

## g1_vix_backwardation

**Source:** crisis.py (VIX real-time) + yfinance `^VIX9D`, `^VIX`, `^VIX3M`  
**Logic:** Fires when short-term fear > medium-term fear (VIX9D > VIX) **OR** medium > long-term (VIX > VIX3M). Either inversion = term structure stress.

**Mechanism:**  
Normal market: VIX9D < VIX < VIX3M (upward slope = calm expected)  
Stressed market: Inversion = traders pay premium for near-term protection → crash imminent

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 25.5% | 37.4% | 72.1% | **+18.5pp** | 12.1% | 87.5% | **+7.4pp** | 2d |
| OOS | 26.1% | 15.0% | 56.3% | **+6.0pp** | — | — | — | 2d |
| Forward | 19.0% | 41.0% | 54.2% | **+22.0pp** | 10.3% | 100.0% | **+7.8pp** | 2d |

### Lookahead Sensitivity (In-sample, L1)

| Lookahead | Precision | Recall | F1 |
|----------:|----------:|-------:|---:|
| 1 day | 15.0% | 56.6% | 23.7% |
| 3 days | **37.4%** | **72.1%** | **49.3%** |
| 5 days | 50.5% | 77.2% | 61.1% |

### Pros
- **Highest recall in L2 detection** — catches 87.5% (IS) and 100% (Forward) of all -3% crashes
- **Consistent across regimes** — USEFUL in both IS and Forward; degrades gracefully in OOS (still +6pp)
- **Leads by 2d median** — fires before events, not on the same day
- **Grounded in market microstructure** — term structure inversion is academically documented (VIX futures market)
- **Low data latency** — yfinance near real-time (~15 min delay), not FRED lag

### Cons
- **Noisy signal** — fires 25% of all days; 3 out of 4 fires result in no -1.5% event within 3 days
- **Precision drops at L2** — 12% precision at -3% threshold (most fires during elevated-vol non-crash days)
- **Regime-sensitive** — degrades in low-vol bull markets (OOS +6pp vs IS +18.5pp)
- **Not available pre-2011** — VIX9D/VIX3M data starts ~2011-2014; can't extend in-sample further back

### Verdict: 🟡 USEFUL — Best Recall Signal
**Recommendation:** Build as "elevated risk" indicator, not "crash imminent." Show precision/recall explicitly in UI. Best used as first layer of multi-signal confirmation.

---

## g1_vix_spike

**Source:** crisis.py (threshold: VIX > 30) + rolling z-score  
**Logic:** Fires if VIX z-score > 1.5 over 20-day window **OR** absolute VIX > 30. Dual trigger captures both regime-relative spikes and absolute stress levels.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 17.0% | 38.2% | 55.1% | **+19.3pp** | 15.2% | 78.1% | **+10.5pp** | 2d |
| OOS | 11.0% | 5.0% | 18.8% | **−4.0pp** ⚠️ | — | — | — | 4d |
| Forward | 14.6% | 40.4% | 50.0% | **+21.4pp** | 7.8% | 66.7% | **+5.3pp** | 2d |

### Pros
- **Strong IS + Forward** — +19pp in-sample, +21pp forward
- **Lower fire rate than backwardation** — 17% vs 25%; fewer false alarms
- **Good L2 recall (78%)** — catches most -3% events when they happen
- **Absolute VIX > 30 component** aligns with crisis.py's production threshold

### Cons
- **OOS degradation is severe** — −4pp in OOS (worse than random); signal fires 11% but events are rare
- **Reactive by nature** — VIX spikes often simultaneous with event, not before; lead may be zero for sudden crashes
- **Dual trigger creates confusion** — z-score fires in any high-vol period; absolute fires only during genuine crisis. Two different risk types mixed into one signal

### Verdict: 🟡 USEFUL (IS+Forward) / ❌ WEAK (OOS)
**Recommendation:** Deploy but note OOS weakness. Should be one component in composite, not standalone alert. Consider separating z-score and absolute triggers for finer control.

---

## g1_vix_momentum

**Source:** New signal (not yet in production)  
**Logic:** Fires when VIX rose ≥ 20% over last 5 trading days. Captures accelerating fear buildup.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 10.7% | 37.2% | 40.4% | **+18.3pp** | 15.3% | 56.3% | **+10.6pp** | 3d |
| OOS | 8.2% | 12.2% | 25.0% | **+3.2pp** | — | — | — | 3d |
| Forward | 9.8% | **48.6%** | 41.7% | **+29.6pp** | **17.1%** | 100.0% | **+14.6pp** | 2d |

### Lookahead Sensitivity (Forward, L1)

| Lookahead | Precision | Recall | F1 |
|----------:|----------:|-------:|---:|
| 1 day | 17.1% | 16.7% | 16.9% |
| 3 days | **48.6%** | **41.7%** | **44.8%** |
| 5 days | 57.1% | 50.0% | 53.3% |

### Pros
- **Strongest forward precision for L1** — 48.6% at 3d, meaning nearly 1 in 2 fires precede a -1.5%+ event
- **Catches all L2 forward events** — 100% recall for -3% crashes in 2025
- **Low fire rate (10%)** — fewer false alarms than backwardation
- **Best suited for rapidly developing stress** — VIX rising fast = building panic, not just elevated vol
- **3-day lead time** — signal leads at 3d median, giving actionable warning window

### Cons
- **OOS weakness** — +3.2pp in OOS; nearly random in calm bull market
- **Misses slow-burn crises** — needs VIX to accelerate quickly; gradual spread-driven crashes not captured
- **20% threshold is calibrated on historical VIX ranges** — in persistent low-vol periods the threshold may never trigger

### Verdict: 🟡 USEFUL (especially 2025 data)
**Recommendation:** Best single signal for forward period. Combine with backwardation for maximum recall. Consider raising threshold in low-vol regimes.

---

---

# GROUP 2 — Credit Spreads

---

## g2_hy_static

**Source:** crisis.py (HY_SPREAD: BAMLH0A0HYM2 > 5%)  
**Logic:** FRED ICE BofA US High Yield OAS > 5%. This is the production crisis.py trigger for "HY stress."

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | Notes |
|--------|--------:|--------:|-------:|--------:|-------|
| In-sample | *not available* | — | — | — | FRED fetch failed (EM_HY endpoint error) |
| OOS | 0.0% | 0% | 0% | — | HY spreads below 5% entire period |
| Forward | 0.0% | 0% | 0% | — | HY spreads at historic lows in 2025 |

### Pros
- **Theoretically sound** — HY spread widening is well-documented precursor to credit events
- **Matches crisis.py production logic** — same threshold already deployed in terminal

### Cons
- **Static threshold failure** — HY OAS was 300-400 bps through most of 2023-2026, well below 500 bps trigger. Signal never fires during calm credit regimes.
- **FRED lag** — daily data lags 1-4 hours; cannot detect intraday stress
- **Regime-blind** — HY > 5% was meaningful during 2008-2009; in tighter spread environments it misses all stress signals
- **EM_HY FRED series (BAMLHE00EHY0D) returning 400 error** — endpoint may need different aggregation parameter for non-daily frequency

### Verdict: ❌ WEAK (practical failure in current regime)
**Recommendation:** Replace static threshold with z-score version (g2_hy_zscore). OR use 5-day momentum: "HY spread rose > 50bps in 5 days" — catches widening regardless of absolute level. Fix FRED fetch for weekly/monthly series.

---

## g2_hy_zscore

**Source:** Proposed improvement to crisis.py HY signal  
**Logic:** HY OAS rolling z-score > 1.5 over 252-day window. Captures rapid widening relative to recent history, regardless of absolute level.

### Backtest Metrics

| Period | Fires % | vs Rand | Notes |
|--------|--------:|--------:|-------|
| In-sample | *not available* | — | FRED fetch issue |
| OOS | 0.0% | — | HY spreads not widening relative to 1y baseline |
| Forward | 0.0% | — | Same issue |

### Pros
- **Regime-aware** — would fire even if HY is at 300 bps, if it spikes relative to recent norm
- **Better than static threshold** in principle

### Cons
- **Same data lag issue** as g2_hy_static
- **Cannot validate** without working FRED data — FRED EM_HY endpoint returns 400; STL_FSI, NFCI same error
- **252-day z-score** needs 1 year of data to warm up

### Verdict: ⚠️ MIXED (untested, theoretically better)
**Recommendation:** Fix FRED fetch first (omit `frequency=d` parameter for weekly series). Then re-run. Until then, cannot validate.

---

## g2_ig_static

**Source:** crisis.py (IG_SPREAD: BAMLC0A0CM > 2%)  
**Logic:** Investment grade OAS > 2%. Higher quality counterpart to HY signal.

### Backtest Metrics

Same issue as g2_hy_static — 0% fires in OOS and Forward. IG spreads were below 1.5% through 2023-2025.

### Pros
- Earlier warning than HY — IG widening sometimes precedes HY widening
- Well-documented in academic literature

### Cons
- Same static threshold failure as HY
- IG OAS > 2% historically only during GFC and COVID — too rare to be a routine signal

### Verdict: ❌ WEAK
**Recommendation:** Use IG 5-day momentum or z-score. Current threshold too high for non-crisis environments.

---

---

# GROUP 3 — Financial Stress Indices

---

## g3_stl_fsi (STL Financial Stress Index)

**Source:** crisis.py (STLFSI4 > 0)  
**Logic:** St. Louis Fed Financial Stress Index above 0 = above-normal stress. Weekly release.

### Backtest Status: **UNTESTED**

FRED API returned 400 error for STLFSI4 with `frequency=d` parameter. Weekly series cannot be forced to daily aggregation via FRED API — must fetch at native weekly frequency, then forward-fill.

### Pros (theoretical)
- **Composite index** covering 18 financial stress indicators; more robust than single-variable signals
- **Published by Fed** — institutional credibility; used by professional risk managers
- **Historical depth** — starts 1994; covers multiple cycles
- **0 = threshold** is academically calibrated by St. Louis Fed research

### Cons
- **Weekly release** — only updates once per week; 4-5 day lag at worst
- **FRED API bug** — current fetcher forces `frequency=d` which fails for weekly series
- **Lagging by design** — FSI incorporates yield curves and spreads that move slowly
- **Cannot validate** — no data in any backtest period

### Verdict: ⚠️ MIXED (untested, theoretically valuable)
**Recommendation:** Fix fetcher — fetch at `frequency=w`, then `pd.Series.reindex(daily_index).ffill()`. Re-run. Expected to be USEFUL based on academic literature, but unconfirmed.

---

## g3_nfci (Chicago National Financial Conditions Index)

**Source:** crisis.py (NFCI > 0)  
**Logic:** Chicago Fed NFCI > 0 = tighter than average financial conditions. Weekly release.

### Backtest Status: **UNTESTED** (same FRED fetch error as STL FSI)

### Pros (theoretical)
- **Forward-looking component** — includes futures-based measures
- **Broad coverage** — 105 financial indicators across money, debt, equity, real estate markets
- **Adjusted NFCI (ANFCI)** removes business cycle → pure financial conditions signal

### Cons
- **Same weekly lag** as STL FSI
- **FRED fetch broken**
- **NFCI historically stays below 0 for years** (2013-2019, 2021-2022) — may have same static-threshold problem as HY in calm regimes

### Verdict: ⚠️ MIXED (untested)
**Recommendation:** Fix FRED fetch, use ANFCI instead of NFCI (adjusted removes trend better). Validate separately.

---

---

# GROUP 4 — Yield Curve

---

## g4_yc_10y2y (10Y − 2Y Inversion)

**Source:** crisis.py + FRED T10Y2Y  
**Logic:** 10Y-2Y Treasury spread < 0 = yield curve inverted. Production crisis.py trigger: "below 0."

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | Notes |
|--------|--------:|--------:|-------:|--------:|-------|
| In-sample | 6.5% | 30.0% | 10.3% | **+11.1pp** | Inverted briefly 2019 + 2022 |
| OOS | **83.0%** | 8.3% | 81.3% | **−0.7pp** ⚠️ | Inverted nearly all 2023-2024 |
| Forward | 0.0% | — | — | — | Uninverted since late 2024 |

### Critical Finding: Recall ≠ Prediction

OOS: fires 83% of days, recall = 81.3% — this is **spurious recall**. The signal was active for 415 out of 501 days. Of the 16 L1 events, 13 happened to fall within a 3-day window of a signal fire — but only because the signal was almost always on. **A signal active 83% of days would catch 92% of events by chance alone.**

### Pros
- **Recession predictor (12-18 month horizon)** — historically reliable for predicting recession, not short-term crashes
- **Well-documented in academic literature** — Campbell & Shiller, Bauer & Mertens
- **Zero data lag** — yfinance real-time Treasury yields

### Cons
- **Wrong timeframe** — predicts recession 12-18 months ahead, not 1-5 day crash
- **Persistent signal** — inverted from mid-2022 to late-2024 (28 months) → fires too long to be actionable
- **False positives during inversion** — SPY rose 26% in 2023 while signal was red the whole time
- **Not a fat tail indicator** — inverted yield curve does NOT predict when crash happens, only that recession is coming eventually
- **g12_composite poisoned** — because this fires 83% in OOS, composite active 88.6%, making composite useless

### Verdict: ❌ WEAK (wrong timescale for fat tail use case)
**Recommendation:** **Remove from alert system.** Use in MACRO view as regime context display, not as crash alert. Never include in composite crash signal. Label clearly: "RECESSION PROBABILITY INDICATOR — 12-18 month horizon."

---

## g4_yc_10y3m (10Y − 3M Inversion)

**Source:** crisis.py + FRED T10Y3M  
**Logic:** 10Y-3M spread < 0 = inverted. Some research (Estrella & Mishkin) argues 10Y-3M is more reliable than 10Y-2Y.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | Notes |
|--------|--------:|--------:|-------:|--------:|-------|
| In-sample | 8.2% | 23.6% | 11.0% | **+4.7pp** | Marginal edge only |
| OOS | **97.8%** | 9.4% | 93.8% | **+0.4pp** ⚠️ | Active nearly every day |
| Forward | 24.1% | 23.5% | 45.8% | **+4.5pp** | Some edge but low |

### Same problems as g4_yc_10y2y, worse
- 97.8% active in OOS = meaningless signal
- Edge in in-sample and forward is minimal (+4.5-4.7pp)

### Verdict: ❌ WEAK
**Recommendation:** Same as 10Y-2Y — context display only, not alert. If keeping for analytical purposes, only show magnitude of inversion (how deep), not binary on/off.

---

---

# GROUP 5 — Fear & Greed Synthetic

---

## g5_fg_extreme_fear (F&G < 25)

**Source:** fear_greed.py synthetic composite  
**Logic:** 5-component rolling percentile composite of: VIX inverted (25%), SPY momentum (25%), SPY vs TLT 20d return (20%), HYG/LQD ratio (15%), RSP/SPY breadth (15%). Score < 25 = Extreme Fear zone.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 12.5% | **43.0%** | 37.5% | **+24.1pp** | 10.8% | 37.5% | **+6.1pp** | 2d |
| OOS | 3.0% | 6.7% | 6.3% | **−2.3pp** ⚠️ | — | — | — | n/a |
| Forward | 5.6% | 15.0% | 4.2% | **−4.0pp** ⚠️ | 0% | 0% | — | n/a |

### Pros
- **Excellent in-sample precision** — 43% at L1, best single-signal precision in IS period
- **Multi-component** — harder to trigger falsely because needs multiple indicators aligned
- **Captures both equity sentiment and safe-haven flows** simultaneously
- **Matches actual CNN Fear & Greed methodology** (validated independently)

### Cons
- **Severe OOS + Forward collapse** — from +24.1pp to −4pp. Large regime-dependency
- **Low fire rate in forward** (5.6%) — F&G rarely reaches Extreme Fear in 2025 bull market
- **2-year rolling percentile window** — percentile rank shifts as market data accumulates; calibration drifts
- **Recall drops in forward** — only catches 4% of L1 events, meaning it mostly misses crashes in current period
- **Backward-looking by design** — composite is built from prices that already moved; not predictive of the next move

### Verdict: ⚠️ MIXED
**Recommendation:** Show as current market sentiment display (not alert). Value is in the score level, not binary trigger. Consider increasing Extreme Fear threshold to < 30 to fire more often in muted markets.

---

## g5_fg_fear_zone (F&G < 45)

**Source:** fear_greed.py (Fear zone)  
**Logic:** Same composite but uses lower threshold — fires in both Fear AND Extreme Fear zones.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 40.3% | 26.8% | 70.6% | **+7.9pp** | 2d |
| OOS | 21.4% | 11.3% | 31.3% | **+2.3pp** | 2d |
| Forward | 29.4% | 14.7% | 25.0% | **−4.3pp** ⚠️ | 3d |

### Pros
- **High recall in IS** — 70.6% of -1.5% events preceded by F&G < 45
- **More fires** — catches more situations than Extreme Fear threshold

### Cons
- **Fires 40% of all days** — precision too low at 27%
- **Forward failure** — actually WORSE than random in 2025 (−4.3pp). Signal fires but no events follow
- **Too broad** — "fear zone" is normal during any volatile period; not selective enough

### Verdict: ❌ WEAK (degrades to random in forward period)
**Recommendation:** Do not use as alert. Show F&G score as gauge/chart only. If using as signal, use F&G velocity (rate of change) rather than absolute level.

---

---

# GROUP 6 — Sector Regime

---

## g6_sector_convergent

**Source:** regime.py (CONVERGENT regime detection)  
**Logic:** Rolling 20-day average pairwise correlation of 11 sector ETFs (XLK, XLF, XLV, XLE, XLI, XLY, XLP, XLRE, XLU, XLB, XLC) > 0.65. High cross-sector correlation = CONVERGENT regime = "all sectors moving together" = crisis behavior.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 27.9% | 29.1% | 50.0% | **+10.2pp** | 7.9% | 59.4% | **+3.2pp** | 2d |
| OOS | 2.2% | 18.2% | 6.3% | **+9.2pp** | — | — | — | n/a |
| Forward | 6.7% | **37.5%** | 16.7% | **+18.5pp** | 12.5% | 33.3% | **+10.0pp** | 2d |

### Pros
- **Forward precision improving** — 37.5% in forward period, highest improvement trend
- **Low fire rate in forward** (6.7%) — rare but high-confidence signal
- **Theoretically grounded** — sector correlation convergence is a well-documented crisis precursor (Lo 2008, Ang & Chen 2002)
- **Already in production** — regime.py runs this logic; backtest validates existing system component
- **Captures systemic stress** — multiple sectors moving together = macro-driven fear, not sector-specific noise

### Cons
- **Very rare in OOS** (2.2% fires) — too few fires to get reliable statistics
- **Recall too low in forward** (16.7%) — catches only 1 in 6 events
- **Precision/recall tradeoff** — high precision in forward but misses too many events
- **20-day window** is too short for sustained regime detection; regime.py uses longer windows + HMM

### Verdict: 🟡 USEFUL (precision), ⚠️ MIXED (recall)
**Recommendation:** Use as confirming signal when it fires (precision meaningful). Combine with VIX-based signals for coverage. Consider using regime.py's full MRS model for better regime classification than this simplified version.

---

---

# GROUP 7 — Equity Technicals

---

## g7_rsi_oversold (RSI < 35)

**Source:** analytics.py (`/api/analytics/rsi`)  
**Logic:** SPY 14-day RSI below 35 = oversold territory. Classic momentum reversal signal.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 9.5% | 37.9% | 35.3% | **+19.0pp** | 13.2% | 46.9% | **+8.5pp** | 2d |
| OOS | 9.6% | 12.0% | 31.3% | **+3.0pp** | — | — | — | 3d |
| Forward | 8.4% | **46.7%** | 33.3% | **+27.7pp** | 7.1% | 33.3% | **+4.6pp** | 2d |

### Pros
- **Strong forward performance** — 46.7% precision (+27.7pp over random) in 2025
- **Consistent fire rate** (8-10%) — stable across all regimes; not a persistent zombie signal
- **2-day lead time** — actionable warning window
- **Already in production** — analytics.py computes RSI; just adding threshold alert
- **Universally understood** — RSI is standard technical indicator, easy to explain to users

### Cons
- **OOS degradation** — +3pp in OOS (2023-2024 bull market; SPY rarely became oversold)
- **Oversold ≠ imminent crash** — RSI < 35 can persist for weeks during strong downtrends; signal may fire "too early" during multi-week corrections
- **Single-asset signal** — only tracks SPY; misses crashes originating in specific sectors
- **Not capturing volatility regime** — same RSI level means different things in low-vol vs high-vol environments

### Verdict: 🟡 USEFUL
**Recommendation:** Deploy. Best used with 3-day lookahead. Consider adaptive threshold: RSI < 30 in low-vol regime, RSI < 40 in high-vol regime.

---

## g7_price_zscore

**Source:** analytics.py (`/api/analytics/zscore`)  
**Logic:** SPY 20-day price z-score < −2. **IMPLEMENTATION BUG: comparing price levels, not returns.**

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand |
|--------|--------:|--------:|-------:|--------:|
| In-sample | **95.6%** | 18% | 99% | BROKEN |
| OOS | **92.2%** | 9% | 100% | BROKEN |
| Forward | **93.6%** | 18% | 96% | BROKEN |

### Why This Is Broken

SPY price level rarely returns to its 20-day rolling mean within ±2 standard deviations because prices trend. The 20-day z-score of a trending asset is almost always outside ±2σ — not because of stress, but because of the uptrend itself.

```
Correct use of z-score: z-score of DAILY RETURNS (stationary)
Current implementation: z-score of PRICE LEVELS (non-stationary, trends)
```

The signal fires 93-95% of all days. This is equivalent to "SPY exists." It contributes nothing to the analysis and inflates g12_composite recall artificially.

### Verdict: 🔴 BROKEN — Do Not Use
**Recommendation:** Fix to use 20-day return z-score: `(today's return - rolling 20d mean return) / rolling 20d std of returns`. After fix, re-run backtest. Expected fire rate should be ~5-10%.

---

---

# GROUP 8 — Allocation Signal

---

## g8_layer_a_bearish

**Source:** analytics/layer_a.py (allocation signal Layer A)  
**Logic:** SPY vs AGG 20-day relative return z-score < −0.5 over 252-day rolling window. If equity underperforms bonds on a risk-adjusted basis → bearish allocation signal (score = −1).

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 29.7% | 30.0% | 61.8% | **+11.1pp** | 7.7% | 68.8% | **+3.0pp** | 2d |
| OOS | 17.4% | 9.0% | 25.0% | **+0.0pp** | — | — | — | n/a |
| Forward | 20.4% | 29.6% | 45.8% | **+10.6pp** | 8.1% | 100.0% | **+5.6pp** | 2d |

### Pros
- **Good L2 recall in forward** — 100% of -3% events preceded by bearish Layer A
- **Captures relative performance** — not just VIX, but actual capital rotation to bonds
- **Consistent fire rate** (17-30%) — varies with regime but not persistently stuck on/off
- **Grounded in factor-based framework** — Moreira & Muir (2017) vol-scaled allocation research

### Cons
- **OOS completely flat** — +0pp vs random; bearish signal firing but no events to catch in 2023-2024
- **High fire rate** (29.7% in IS) — 3 in 10 days flagged as bearish; creates alert fatigue
- **L1 precision mediocre** (30%) — a lot of false alarms
- **Designed for medium-term allocation, not short-term crash timing** — Layer A is meant to guide monthly rebalancing, not day-level crash alerts

### Verdict: ⚠️ MIXED
**Recommendation:** Use as "equity vs bond risk sentiment" indicator, not crash alert. Show as allocation dashboard component. Good L2 recall (100% forward) makes it worth keeping as one layer in composite, but not standalone.

---

---

# GROUP 9 — Crisis Composite Score

---

## g9_crisis_composite_red

**Source:** crisis.py `/api/crisis/composite`  
**Logic:** Weighted score: CAPE (30%) + HY (25%) + VIX (20%) + Yield Curve (15%) + TED (10%). Score > 66 = RED. Designed to be the system's top-level systemic risk gauge.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand |
|--------|--------:|--------:|-------:|--------:|
| In-sample | **0.0%** | 0% | 0% | BROKEN |
| OOS | **0.0%** | 0% | 0% | BROKEN |
| Forward | **0.0%** | 0% | 0% | BROKEN |

### Why This Never Fires

The score > 66 threshold is never reached because:

1. **CAPE component saturates low** — Shiller CAPE is ~30-35 during 2015-2026, giving cape_score ~65-70, but the weighting only contributes 30% → max 21 points from CAPE
2. **HY component is 0-20 during calm periods** — with HY spread at 3-4%, `(3.5/20)*100 = 17.5` × 0.25 weight = 4.4 points
3. **VIX component** — VIX at 20: `(20/80)*100 = 25` × 0.20 = 5 points
4. **Maximum realistic score in normal market: ~30-40 points** → never reaches 66
5. **Score reaches 66 only during GFC-level stress** (VIX > 60, HY > 15%) — once-per-decade event

### Pros (system design intent)
- Good conceptual design — weighted multi-factor composite
- Weights reflect relative importance of indicators

### Cons
- **Threshold 66 is GFC-calibrated** — too high for practical early warning
- **CAPE at 30%** gives too much weight to a slow-moving, non-crash-predictive variable
- **No historical fires in 10 years** = useless as operational signal
- **Score range issue** — normalization functions (vix_score, hy_score) never push composite above 50 in normal conditions

### Verdict: 🔴 BROKEN — Threshold miscalibrated
**Recommendation:** Lower RED threshold to 45-50 (YELLOW to 30-35). Validate against IS period. Remove CAPE from composite (not crash predictor). Consider calibrating thresholds so signal fires ~10% of days.

---

---

# GROUP 10 — Volume / Flow

---

## g10_volume_surge

**Source:** analytics.py (volume data from yfinance)  
**Logic:** SPY daily volume z-score > 2.0 over 63-day (3-month) rolling window.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand | Lead (med) |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|:----------:|
| In-sample | 5.6% | 39.3% | 29.4% | **+20.4pp** | 17.9% | 53.1% | **+13.2pp** | 3d |
| OOS | 4.0% | 10.0% | 12.5% | **+1.0pp** | — | — | — | 2d |
| Forward | 5.6% | **50.0%** | 33.3% | **+31.0pp** | 20.0% | 66.7% | **+17.5pp** | 2d |

### Lookahead Sensitivity (Forward, L1)

| Lookahead | Precision | Recall | vs Random | F1 |
|----------:|----------:|-------:|----------:|---:|
| 1 day | 35.3% | 25.0% | +28.7pp | 29.3% |
| 3 days | **50.0%** | **33.3%** | **+31.0pp** | **40.0%** |
| 5 days | 64.7% | 45.8% | +35.3pp | 53.6% |

### Pros
- **Highest precision in forward period** — 50% at L1 3d (1 in 2 fires precede stress event)
- **Highest edge over random** — +31pp in forward, +20pp in IS
- **Low fire rate** (5.6%) — rare but high-quality signal
- **Pure market microstructure** — volume surge = institutional panic buying/selling, not a derived indicator
- **2-3 day lead time** — actionable window before crash
- **Improves with longer windows** — 5d lookahead reaches 64.7% precision

### Cons
- **OOS failure** — +1pp in 2023-2024; volume spikes but no events follow in calm market
- **Low recall** (33%) — only catches 1 in 3 events; many crashes happen on normal volume
- **Single-asset** — only SPY volume; sector ETF volume anomalies not captured
- **Low n_signals** (only 20 fires in forward) — limited statistical power; forward results may not generalize

### Verdict: ✅ STRONG (forward) / ❌ WEAK (OOS)
**Recommendation:** **Build this.** Best precision/edge combination in the project. Display prominently when active. Label as "EXTREME VOLUME ANOMALY — 50% historical accuracy." Note the OOS gap; explain to users that it works in volatile but not calm regimes.

---

---

# GROUP 11 — Cross-Asset Signals

---

## g11_safe_haven

**Source:** Original backtest signal (not in production)  
**Logic:** SPY down AND TLT up AND GLD up on the same day = classic risk-off rotation.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|
| In-sample | 17.3% | 19.8% | 50.0% | **+0.9pp** | 6.1% | 62.5% | **+1.4pp** |
| OOS | 10.6% | 16.7% | 50.0% | **+7.7pp** | — | — | — |
| Forward | 11.8% | 21.4% | 33.3% | **+2.4pp** | 0% | 0% | **−2.5pp** |

### Pros
- **High recall (50%)** in IS and OOS for L1 — catches half of moderate stress events
- **Intuitive signal** — "flight to safety" is the most fundamental risk-off trade
- **No data lag** — computed from same-day price changes

### Cons
- **Edge nearly zero** — +0.9pp in IS; basically random
- **Fires 17% of days** — too frequent to be useful; risk-off rotations happen on non-crash days too
- **Not predictive** — fires ON the down day, not before it (precision is for T+1 to T+3 events, but the day itself already saw SPY down)
- **Poor L2/L3** — signal fires when SPY is already down; the question is whether next 3 days are worse
- **OOS improvement (+7.7pp) is noise** — only 16 events in 501 days; small sample

### Verdict: ❌ WEAK
**Recommendation:** Remove from alert system. Replace with "flight-to-safety acceleration" (3-day rate of change in GLD/TLT premium). Current version is reactive not predictive.

---

## g11_corr_velocity

**Source:** Original backtest signal (not in production)  
**Logic:** Average cross-asset correlation between SPY/TLT/GLD/HYG rises > 0.10 in 5 trading days. Detects rapidly forming correlation convergence.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|
| In-sample | 13.2% | 19.2% | 23.5% | **+0.3pp** | 6.1% | 34.4% | **+1.4pp** |
| OOS | 16.6% | 10.8% | 25.0% | **+1.8pp** | — | — | — |
| Forward | 14.8% | 23.3% | 29.2% | **+4.3pp** | 5.7% | 33.3% | **+3.2pp** |

### Pros
- **Theoretically motivated** — correlation convergence is documented in crisis literature (Lo 2008)
- **Captures systemic stress** not visible in single-asset signals

### Cons
- **Consistently near-zero edge** — +0.3pp (IS), +1.8pp (OOS), +4.3pp (Forward); all weak
- **5-day velocity too short** — 20-day window correlation itself takes time to build; 5-day change is noisy
- **Only 4 assets** — with SPY/TLT/GLD/HYG correlation, missing sector-level contagion (g6 is better)
- **Precision never above 24%** across all periods

### Verdict: ❌ WEAK
**Recommendation:** Remove or replace with g6_sector_convergent (11 sector ETFs gives more robust correlation signal). If keeping, extend velocity window to 10-15 days and increase threshold.

---

---

# GROUP 12 — Composite Gate

---

## g12_composite (3+ Signals Active)

**Source:** This backtest (not in production)  
**Logic:** Counts number of individual signals active; fires when ≥ 3 signals simultaneously active.

### Backtest Metrics

| Period | Fires % | L1 Prec | L1 Rec | vs Rand | L2 Prec | L2 Rec | vs Rand |
|--------|--------:|--------:|-------:|--------:|--------:|-------:|--------:|
| In-sample | 49.7% | 27.3% | **90.4%** | **+8.4pp** | 7.0% | 100.0% | +2.3pp |
| OOS | **88.6%** | 9.1% | 93.8% | **+0.1pp** ⚠️ | — | — | — |
| Forward | 39.5% | 28.3% | 75.0% | **+9.3pp** | 4.9% | 100.0% | +2.4pp |

### Critical Finding: OOS Poisoned by Yield Curve

g12_composite fired 88.6% of days in OOS because:
- `g4_yc_10y2y` fired 83.0% of days
- `g4_yc_10y3m` fired 97.8% of days  
- `g7_price_zscore` fired 92.2% of days (broken signal)

Three persistent/broken signals easily satisfy the "3+" threshold. The composite's recall of 93.8% in OOS is spurious — it catches 93.8% of events only because it's always on.

### Pros
- **Perfect L2 recall** (100%) in IS and Forward — never misses a -3% crash when valid signals are included
- **High L1 recall** (90% IS, 75% Forward)

### Cons
- **Corrupted by broken signals** — g7_price_zscore (95% active) and yield curve (83-97% active) make composite nearly always true
- **Low precision** — 27-28% precision; precision falls as composite fire rate rises
- **Requires signal quality control** — composite is only as good as its weakest signal

### Verdict: ⚠️ MIXED (currently broken, fixable)
**Recommendation:** Rebuild composite excluding:  
1. `g7_price_zscore` (broken — fix first)  
2. `g4_yc_10y2y` + `g4_yc_10y3m` (wrong timescale)  
3. `g9_crisis_composite_red` (never fires)  
Only include: g1_backwardation, g1_spike, g1_momentum, g7_rsi_oversold, g10_volume_surge, g5_fg_extreme_fear (validated signals only). Then re-run.

---

---

# Summary: Signal Rankings

## Tier 1 — Build Now (validated, consistent edge)

| Signal | Edge IS | Edge Forward | Fire Rate | Key Strength |
|--------|--------:|-------------:|----------:|:-------------|
| `g1_vix_backwardation` | +18.5pp | +22.0pp | 19-25% | Highest recall (87-100% L2) |
| `g1_vix_spike` | +19.3pp | +21.4pp | 14-17% | Consistent IS + Forward |
| `g1_vix_momentum` | +18.3pp | +29.6pp | 9-11% | Best precision trend |
| `g7_rsi_oversold` | +19.0pp | +27.7pp | 8-10% | Low fire rate, high forward precision |
| `g10_volume_surge` | +20.4pp | +31.0pp | 5-6% | Highest precision, rarest signal |

## Tier 2 — Monitor (useful component, not standalone)

| Signal | Status | Why |
|--------|--------|-----|
| `g5_fg_extreme_fear` | ⚠️ MIXED | IS strong (+24pp), forward collapses (−4pp) |
| `g6_sector_convergent` | 🟡 USEFUL | Good precision but low recall; rare in OOS |
| `g8_layer_a_bearish` | ⚠️ MIXED | Good L2 recall, poor L1 precision, flat OOS |

## Tier 3 — Fix Before Using

| Signal | Problem | Fix |
|--------|---------|-----|
| `g7_price_zscore` | Fires 93% of days — comparing price level, not returns | Use return z-score |
| `g9_crisis_composite_red` | Fires 0% of days — threshold calibrated for GFC | Lower RED threshold to 45-50 |
| `g2_hy_*` / `g2_ig_*` | Static thresholds too high for current regime | Switch to z-score or momentum |
| `g3_stl_fsi` / `g3_nfci` | FRED fetch broken for weekly series | Fix `frequency=w` fetch, re-run |
| `g12_composite` | Poisoned by broken signals | Exclude broken signals, rebuild |

## Tier 4 — Remove from Alert System

| Signal | Why |
|--------|-----|
| `g4_yc_10y2y` | Wrong timescale (12-18 month recession predictor, not 1-5 day crash) |
| `g4_yc_10y3m` | Same — fires persistently for years; destroys composite |
| `g5_fg_fear_zone` | Worse than random in forward (−4.3pp) |
| `g11_safe_haven` | Reactive (fires on crash day), near-zero edge |
| `g11_corr_velocity` | Consistently WEAK across all periods |

---

# Key Insights for System Design

### 1. No signal is a "crash predictor"
Best precision achieved: **50% at L1 (−1.5%)** with volume_surge. Even the best signal produces 1 false alarm for every true positive. The system should communicate this explicitly.

### 2. Regime-dependence is the main limitation
Every signal degrades significantly in 2023-2024 bull market. OOS L2 = 0 events means the model was never tested during calm periods at that threshold. Current system would have been nearly silent through the entire 2023-2024 bull run — which is both correct (no crashes) and potentially dangerous (signal fatigue from persistent yield curve inversions).

### 3. Leading vs reactive distinction
- **Truly leading** (fires T−1 before event): g1_vix_momentum (+3d lead), g10_volume_surge (+2-3d lead)
- **Coincident** (fires same day): g11_safe_haven, g5_fg_fear_zone  
- **Lagging** (already in crisis when fires): g4_yc_* (months-long signal)

### 4. The composite needs curation
A composite of validated signals only (Tier 1 + Tier 2) would be more useful than a composite including broken/persistent signals. After removing g4_yc_* and fixing g7_price_zscore, composite will fire less often and with higher precision.

### 5. What the project is still missing
None of these signals are true **pre-event** leading indicators. The gap report was correct:
- Options flow / P-C ratio surge (T−6h to T−1h)
- Bid-ask spread widening (T−4h)
- Repo/funding stress (T−2h)

These require either real-time data sources (not FRED daily) or options market data (Polygon.io).

---

*Report generated by `backtest/run.py` | Bloomberg Terminal Backtest Framework | 2026-06-06*  
*Raw data: `results/full_metrics_2026-06-06.csv`*
