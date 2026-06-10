# Backtest Framework -- Bloomberg Terminal

Standalone backtest modules for validating all risk/signal components.
Each subfolder is an independent backtest with its own runner and results.

---

## Folder Structure

```
backtest/
|
|-- README.md                           <- you are here
|
|-- engine.py                           <- shared: precision/recall engine
|-- config.py                           <- shared: periods, thresholds, symbols
|-- fetcher.py                          <- shared: yfinance + FRED data fetching
|-- signals.py                          <- shared: all 19 signal definitions (g1-g12)
|
|-- 01_signal_precision_recall/         <- Signal P/R backtest (COMPLETE)
|   |-- run.py                          <- runner
|   `-- results/
|       `-- 2026-06-06/
|           |-- full_report.md          <- comprehensive report
|           |-- signal_analysis.md      <- per-signal deep-dive
|           |-- full_metrics.csv        <- raw metrics (all periods/signals/levels)
|           |-- metrics_insample.csv    <- IS only (2015-2022)
|           |-- metrics_oos.csv         <- OOS only (2023-2024)
|           |-- metrics_forward.csv     <- Forward only (2025-present)
|           `-- forward_status.csv      <- current signal state (last 10 days)
|
|-- 02_dcc_correlation_monitor/         <- DCC-EWMA correlation spike (COMPLETE)
|   |-- run.py                          <- runner + unit tests (3 models: v1/v2/v3)
|   `-- results/
|       `-- 2026-06-07/
|           |-- report.md               <- full 3-model comparison report
|           |-- pr_all_models.csv       <- IS/OOS/FWD P/R for all 3 models
|           |-- pr_v1.csv / pr_v2.csv / pr_v3.csv
|           |-- pr_current_status.csv   <- last 10 days all models
|           `-- event_summary.csv       <- per-event result (16 events)
|
|-- 03_var_model_validation/            <- Kupiec/DQ VaR tests (NOT STARTED)
|   `-- README.md
|
`-- 04_stress_scenarios/                <- Historical scenario replay (NOT STARTED)
    `-- README.md
```

---

## Backtest Modules

### 01 -- Signal Precision/Recall
**What:** Tests 19 early-warning signals against SPY fat-tail events (-1.5%, -3%, -5%)
**Periods:** In-sample 2015-2022, OOS 2023-2024, Forward 2025-present
**Metrics:** Precision, Recall, F1, edge-over-random, median lead time
**Run:** `python 01_signal_precision_recall/run.py`
**Last run:** 2026-06-06

Key findings from 2026-06-06 run:
- **Tier 1 (validated):** g10_volume_surge (+31pp forward), g1_vix_momentum (+30pp forward), g7_rsi_oversold (+28pp forward)
- **Broken signals:** g7_price_zscore (fires 93% of days -- level z-score, not return z-score), g9_crisis_composite_red (never fires -- GFC threshold too high), g4_yc_10y2y (fires 83% OOS -- wrong timescale)
- **No signal exceeds 50% precision** -- system communicates probability elevation, not crash prediction

---

### 02 -- DCC-EWMA Correlation Monitor
**What:** Tests EWMA-DCC vs A-DCC (asymmetric) vs HMM regime detection — event backtest + continuous IS/OOS/FWD precision/recall
**Algorithm:** Symmetric EWMA-DCC (v1, production) + A-DCC (v2) + HMM 2-regime (v3) comparison
**Assets:** SPY, QQQ, TLT, GLD, NVDA, HYG (credit), XLF (financials)
**Run:** `python 02_dcc_correlation_monitor/run.py`
**Last run:** 2026-06-07

Event detection (16 events, 10 non-SUDDEN):
- **v1 Symmetric EWMA-DCC: 8/10 pass** (production model)
- **v2 A-DCC (fixed params): 5/10 pass** — WORSE; needs MLE calibration to outperform symmetric
- **v3 HMM 2-regime: 9/10 pass** — BEST; captures 2022 Rate Shock + Apr 2025 Tariff Shock that v1 misses

Continuous P/R (CAUTION+, L1=-1.5%, 5d lookahead — best config):
| Period | v1 Prec | v1 Edge | v3 Prec | v3 Edge | v3 Recall |
|--------|---------|---------|---------|---------|-----------|
| IS (2015-2022) | 29% | +22pp | 30% | +23pp | 84% |
| OOS (2023-2024) | 11% | +8pp | 14% | +11pp | 56% |
| FWD (2025-present) | 18% | +11pp | 22% | +16pp | 67% |

Notable: v3 HMM-EXTREME on OOS shows 58% precision (+55pp edge) at 5d — highest precision of any signal/model tested.

Key findings:
- **A-DCC limitation:** Hand-tuned alpha/gamma hurts gradual selloffs (Dot-com, China 2015, 2022 Rate). Reverted from production.
- **HMM strength:** IS-fit 2015-2022, walk-forward OOS/FWD — highest event detection (9/10), best recall on gradual regime shifts.
- **GFC Lehman still FAIL (all models):** 252d lookback includes Bear Stearns (Mar 2008); pre-Lehman correlations look normal relative to already-elevated window.
- **Unit tests: 5/5 pass**

Production model (`risk.py`): Symmetric EWMA-DCC (v1). A-DCC reverted. HMM is backtest-only (not yet in production).
DCC in `/api/v2/portfolio/risk/metrics` under `dcc` key. EWS max: 21 (includes +0/1/2/3 DCC).

---

### 03 -- VaR Model Validation (NOT STARTED)
**What:** Kupiec POF + DQ tests on historical VaR exception rates
**Purpose:** Validate that Parametric/Cornish-Fisher/Monte Carlo VaR models are well-calibrated
**See:** `03_var_model_validation/README.md`

---

### 04 -- Stress Scenarios (NOT STARTED)
**What:** Replay 5 historical crash scenarios on current portfolio positions
**Purpose:** "If COVID happened today, how much would I lose?"
**See:** `04_stress_scenarios/README.md`

---

## How to Run

```powershell
# From project root
cd backtest

# Signal precision/recall (30-60 min, downloads 10yr data)
python 01_signal_precision_recall/run.py

# DCC correlation monitor (5-10 min)
python 02_dcc_correlation_monitor/run.py
```

Requirements: numpy, pandas, scipy, yfinance (all already in backend requirements)

---

## Results Naming Convention

```
XX_<backtest-name>/results/YYYY-MM-DD/<output-file>
```

Each run creates a dated subfolder. Latest results are always in the highest-date folder.

---

## Shared Modules

| File | Purpose |
|------|---------|
| `engine.py` | Precision/recall computation, event definition |
| `config.py` | Period dates, crash level thresholds, signal params |
| `fetcher.py` | yfinance + FRED data fetching with caching |
| `signals.py` | All 19 signal implementations (g1-g12) |

These are used by `01_signal_precision_recall/run.py` only.
`02_dcc_correlation_monitor/run.py` imports from `backend/routers/risk.py` directly.
