# DCC Correlation Monitor -- Full 3-Model Comparison Backtest
**Generated:** 2026-06-07
**Models:**
  - v1: Symmetric EWMA-DCC (RiskMetrics 1994, lambda=0.94) -- **production model**
  - v2: Asymmetric A-DCC (Cappiello-Engle-Sheppard 2006, alpha=0.04, gamma=0.02)
  - v3: HMM 2-regime (GaussianHMM, IS-fit 2015-2022, walk-forward predict) [active]
**Assets:** SPY, QQQ, TLT, GLD, NVDA, HYG, XLF
**Periods:** IS=2015-2022 | OOS=2023-2024 | FWD=2025-present

---

## 1. Unit Tests

| Test | Result | Detail |
|------|--------|--------|
| `v1_spike_on_correlated_data` | PASS | v1 signal=SPIKE avg_corr=0.4098 |
| `v2_amplifies_on_crash` | PASS | v1=SPIKE v2=SPIKE (v2>=v1 on all-negative crash) |
| `v3_detects_regime_shift` | PASS | v3 signal=SPIKE prob_crisis=1.0 |
| `normal_on_independent_data` | PASS | v1=NORMAL v2=NORMAL on uncorrelated data |
| `pr_engine_precision_recall` | PASS | precision=1.0 recall=1.0 |

**Unit Tests: 5/5 PASS**

---

## 2. Precision / Recall -- All Models × All Periods

**How to read:**
- Prec = % signal days followed by SPY crash within lookahead
- vsRand = edge over event-rate baseline
- Recall = % crash days preceded by signal
- FP% = false positive rate (1-prec)
- v3 HMM: IS-fitted model, applied walk-forward to OOS and FWD (no look-ahead bias)

### CAUTION+ (any alert) -> SPY <= -1.5%

| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |
|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|
| v1 | IS (2015-2022) | 1d | 49.2% | 6.9% | 8% | +1pp | 55% | 14% | 1.0d | 92.3% | WEAK |
| v1 | IS (2015-2022) | 3d | 49.2% | 6.9% | 21% | +14pp | 65% | 32% | 2.0d | 79.1% | SENSITIVE |
| v1 | IS (2015-2022) | 5d | 49.2% | 6.9% | 29% | +22pp | 70% | 42% | 3.0d | 70.6% | SENSITIVE |
| v1 | OOS (2023-2024) | 1d | 35.3% | 3.2% | 3% | +-0pp | 31% | 5% | 1.0d | 97.2% | WEAK |
| v1 | OOS (2023-2024) | 3d | 35.3% | 3.2% | 7% | +4pp | 38% | 12% | 3.5d | 93.2% | WEAK |
| v1 | OOS (2023-2024) | 5d | 35.3% | 3.2% | 11% | +8pp | 44% | 17% | 5.0d | 89.3% | MIXED |
| v1 | FWD (2025-present) | 1d | 48.2% | 6.7% | 5% | +-2pp | 33% | 8% | 1.0d | 95.3% | WEAK |
| v1 | FWD (2025-present) | 3d | 48.2% | 6.7% | 12% | +5pp | 42% | 19% | 2.0d | 87.8% | MIXED |
| v1 | FWD (2025-present) | 5d | 48.2% | 6.7% | 18% | +11pp | 46% | 26% | 3.0d | 82.0% | MIXED |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v2 | IS (2015-2022) | 1d | 49.7% | 6.9% | 8% | +1pp | 56% | 14% | 1.0d | 92.2% | WEAK |
| v2 | IS (2015-2022) | 3d | 49.7% | 6.9% | 21% | +14pp | 66% | 32% | 2.0d | 79.2% | SENSITIVE |
| v2 | IS (2015-2022) | 5d | 49.7% | 6.9% | 29% | +22pp | 74% | 42% | 3.0d | 70.6% | SENSITIVE |
| v2 | OOS (2023-2024) | 1d | 33.5% | 3.2% | 3% | +-0pp | 31% | 5% | 1.0d | 97.0% | WEAK |
| v2 | OOS (2023-2024) | 3d | 33.5% | 3.2% | 8% | +4pp | 38% | 13% | 4.0d | 92.3% | WEAK |
| v2 | OOS (2023-2024) | 5d | 33.5% | 3.2% | 12% | +9pp | 44% | 19% | 5.0d | 88.1% | MIXED |
| v2 | FWD (2025-present) | 1d | 52.1% | 6.7% | 5% | +-1pp | 42% | 10% | 1.0d | 94.6% | WEAK |
| v2 | FWD (2025-present) | 3d | 52.1% | 6.7% | 14% | +7pp | 46% | 21% | 2.0d | 86.0% | MIXED |
| v2 | FWD (2025-present) | 5d | 52.1% | 6.7% | 19% | +13pp | 50% | 28% | 3.0d | 80.6% | MIXED |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v3 | IS (2015-2022) | 1d | 55.9% | 6.9% | 9% | +2pp | 70% | 16% | 1.0d | 91.3% | WEAK |
| v3 | IS (2015-2022) | 3d | 55.9% | 6.9% | 21% | +14pp | 77% | 33% | 2.0d | 79.0% | SENSITIVE |
| v3 | IS (2015-2022) | 5d | 55.9% | 6.9% | 30% | +23pp | 84% | 44% | 3.0d | 70.5% | SENSITIVE |
| v3 | OOS (2023-2024) | 1d | 46.6% | 3.2% | 3% | +0pp | 50% | 6% | 1.0d | 96.6% | WEAK |
| v3 | OOS (2023-2024) | 3d | 46.6% | 3.2% | 9% | +6pp | 56% | 16% | 2.5d | 90.6% | MIXED |
| v3 | OOS (2023-2024) | 5d | 46.6% | 3.2% | 14% | +11pp | 56% | 22% | 4.0d | 86.3% | MIXED |
| v3 | FWD (2025-present) | 1d | 55.2% | 6.7% | 7% | +-0pp | 54% | 12% | 1.0d | 93.4% | WEAK |
| v3 | FWD (2025-present) | 3d | 55.2% | 6.7% | 16% | +10pp | 62% | 26% | 2.0d | 83.8% | MIXED |
| v3 | FWD (2025-present) | 5d | 55.2% | 6.7% | 22% | +16pp | 67% | 34% | 3.0d | 77.7% | SENSITIVE |

### CAUTION+ (any alert) -> SPY <= -3%

| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |
|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|
| v1 | IS (2015-2022) | 1d | 49.2% | 1.7% | 2% | +-0pp | 43% | 3% | 1.0d | 98.5% | WEAK |
| v1 | IS (2015-2022) | 3d | 49.2% | 1.7% | 4% | +3pp | 57% | 8% | 3.0d | 95.6% | WEAK |
| v1 | IS (2015-2022) | 5d | 49.2% | 1.7% | 6% | +5pp | 67% | 12% | 4.0d | 93.5% | WEAK |
| v1 | OOS (2023-2024) | 1d | 35.3% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | OOS (2023-2024) | 3d | 35.3% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | OOS (2023-2024) | 5d | 35.3% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | FWD (2025-present) | 1d | 48.2% | 0.8% | 1% | +-0pp | 33% | 1% | 1.0d | 99.4% | WEAK |
| v1 | FWD (2025-present) | 3d | 48.2% | 0.8% | 2% | +1pp | 33% | 3% | 2.0d | 98.3% | WEAK |
| v1 | FWD (2025-present) | 5d | 48.2% | 0.8% | 2% | +1pp | 33% | 3% | 2.0d | 98.3% | WEAK |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v2 | IS (2015-2022) | 1d | 49.7% | 1.7% | 2% | +-0pp | 43% | 3% | 1.0d | 98.5% | WEAK |
| v2 | IS (2015-2022) | 3d | 49.7% | 1.7% | 5% | +3pp | 57% | 8% | 3.0d | 95.4% | WEAK |
| v2 | IS (2015-2022) | 5d | 49.7% | 1.7% | 7% | +5pp | 67% | 12% | 4.0d | 93.3% | MIXED |
| v2 | OOS (2023-2024) | 1d | 33.5% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | OOS (2023-2024) | 3d | 33.5% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | OOS (2023-2024) | 5d | 33.5% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | FWD (2025-present) | 1d | 52.1% | 0.8% | 0% | +-0pp | 33% | 1% | 1.0d | 99.5% | WEAK |
| v2 | FWD (2025-present) | 3d | 52.1% | 0.8% | 2% | +1pp | 33% | 3% | 2.0d | 98.4% | WEAK |
| v2 | FWD (2025-present) | 5d | 52.1% | 0.8% | 2% | +1pp | 33% | 3% | 2.0d | 98.4% | WEAK |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v3 | IS (2015-2022) | 1d | 55.9% | 1.7% | 3% | +1pp | 87% | 5% | 1.0d | 97.4% | WEAK |
| v3 | IS (2015-2022) | 3d | 55.9% | 1.7% | 6% | +5pp | 90% | 12% | 2.0d | 93.6% | WEAK |
| v3 | IS (2015-2022) | 5d | 55.9% | 1.7% | 9% | +7pp | 90% | 16% | 3.0d | 91.4% | MIXED |
| v3 | OOS (2023-2024) | 1d | 46.6% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | OOS (2023-2024) | 3d | 46.6% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | OOS (2023-2024) | 5d | 46.6% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | FWD (2025-present) | 1d | 55.2% | 0.8% | 2% | +1pp | 100% | 3% | 1.0d | 98.5% | WEAK |
| v3 | FWD (2025-present) | 3d | 55.2% | 0.8% | 3% | +2pp | 100% | 6% | 1.5d | 97.0% | WEAK |
| v3 | FWD (2025-present) | 5d | 55.2% | 0.8% | 4% | +3pp | 100% | 7% | 2.0d | 96.4% | WEAK |

### SPIKE+ -> SPY <= -1.5%

| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |
|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|
| v1 | IS (2015-2022) | 1d | 22.9% | 6.9% | 9% | +2pp | 30% | 14% | 1.0d | 91.1% | WEAK |
| v1 | IS (2015-2022) | 3d | 22.9% | 6.9% | 24% | +17pp | 37% | 29% | 2.0d | 76.5% | MIXED |
| v1 | IS (2015-2022) | 5d | 22.9% | 6.9% | 35% | +28pp | 41% | 38% | 3.5d | 65.3% | MIXED |
| v1 | OOS (2023-2024) | 1d | 2.8% | 3.2% | 7% | +4pp | 6% | 7% | 1.0d | 92.9% | WEAK |
| v1 | OOS (2023-2024) | 3d | 2.8% | 3.2% | 7% | +4pp | 6% | 7% | 1.0d | 92.9% | WEAK |
| v1 | OOS (2023-2024) | 5d | 2.8% | 3.2% | 21% | +18pp | 12% | 16% | 7.0d | 78.6% | MIXED |
| v1 | FWD (2025-present) | 1d | 26.9% | 6.7% | 4% | +-2pp | 17% | 7% | 1.0d | 95.8% | WEAK |
| v1 | FWD (2025-present) | 3d | 26.9% | 6.7% | 10% | +4pp | 25% | 15% | 2.5d | 89.6% | WEAK |
| v1 | FWD (2025-present) | 5d | 26.9% | 6.7% | 15% | +8pp | 29% | 19% | 3.5d | 85.4% | MIXED |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v2 | IS (2015-2022) | 1d | 23.7% | 6.9% | 8% | +2pp | 29% | 13% | 1.0d | 91.6% | WEAK |
| v2 | IS (2015-2022) | 3d | 23.7% | 6.9% | 21% | +14pp | 34% | 26% | 3.0d | 78.9% | MIXED |
| v2 | IS (2015-2022) | 5d | 23.7% | 6.9% | 31% | +24pp | 40% | 35% | 4.0d | 69.1% | MIXED |
| v2 | OOS (2023-2024) | 1d | 4.2% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v2 | OOS (2023-2024) | 3d | 4.2% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v2 | OOS (2023-2024) | 5d | 4.2% | 3.2% | 5% | +2pp | 6% | 5% | 8.0d | 95.2% | WEAK |
| v2 | FWD (2025-present) | 1d | 28.6% | 6.7% | 6% | +-1pp | 25% | 10% | 1.0d | 94.1% | WEAK |
| v2 | FWD (2025-present) | 3d | 28.6% | 6.7% | 15% | +8pp | 38% | 21% | 2.0d | 85.3% | MIXED |
| v2 | FWD (2025-present) | 5d | 28.6% | 6.7% | 20% | +13pp | 38% | 26% | 3.0d | 80.4% | MIXED |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v3 | IS (2015-2022) | 1d | 21.1% | 6.9% | 8% | +1pp | 24% | 12% | 1.0d | 92.2% | WEAK |
| v3 | IS (2015-2022) | 3d | 21.1% | 6.9% | 21% | +14pp | 28% | 24% | 3.0d | 79.2% | MIXED |
| v3 | IS (2015-2022) | 5d | 21.1% | 6.9% | 32% | +25pp | 30% | 31% | 4.0d | 68.2% | MIXED |
| v3 | OOS (2023-2024) | 1d | 4.8% | 3.2% | 4% | +1pp | 6% | 5% | 4.0d | 95.8% | WEAK |
| v3 | OOS (2023-2024) | 3d | 4.8% | 3.2% | 25% | +22pp | 19% | 21% | 4.5d | 75.0% | MIXED |
| v3 | OOS (2023-2024) | 5d | 4.8% | 3.2% | 33% | +30pp | 19% | 24% | 5.0d | 66.7% | MIXED |
| v3 | FWD (2025-present) | 1d | 27.7% | 6.7% | 7% | +0pp | 29% | 11% | 1.0d | 92.9% | WEAK |
| v3 | FWD (2025-present) | 3d | 27.7% | 6.7% | 17% | +10pp | 29% | 22% | 2.0d | 82.8% | MIXED |
| v3 | FWD (2025-present) | 5d | 27.7% | 6.7% | 24% | +18pp | 29% | 26% | 3.5d | 75.8% | MIXED |

### SPIKE+ -> SPY <= -3%

| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |
|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|
| v1 | IS (2015-2022) | 1d | 22.9% | 1.7% | 1% | +-1pp | 17% | 2% | 1.0d | 98.8% | WEAK |
| v1 | IS (2015-2022) | 3d | 22.9% | 1.7% | 3% | +1pp | 23% | 5% | 2.0d | 97.0% | WEAK |
| v1 | IS (2015-2022) | 5d | 22.9% | 1.7% | 4% | +3pp | 30% | 8% | 3.5d | 95.5% | WEAK |
| v1 | OOS (2023-2024) | 1d | 2.8% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | OOS (2023-2024) | 3d | 2.8% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | OOS (2023-2024) | 5d | 2.8% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | FWD (2025-present) | 1d | 26.9% | 0.8% | 1% | +0pp | 33% | 2% | 1.0d | 99.0% | WEAK |
| v1 | FWD (2025-present) | 3d | 26.9% | 0.8% | 3% | +2pp | 33% | 6% | 2.0d | 96.9% | WEAK |
| v1 | FWD (2025-present) | 5d | 26.9% | 0.8% | 3% | +2pp | 33% | 6% | 2.0d | 96.9% | WEAK |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v2 | IS (2015-2022) | 1d | 23.7% | 1.7% | 2% | +0pp | 30% | 4% | 1.0d | 97.8% | WEAK |
| v2 | IS (2015-2022) | 3d | 23.7% | 1.7% | 5% | +3pp | 30% | 8% | 2.0d | 95.2% | WEAK |
| v2 | IS (2015-2022) | 5d | 23.7% | 1.7% | 7% | +5pp | 40% | 12% | 3.0d | 93.3% | MIXED |
| v2 | OOS (2023-2024) | 1d | 4.2% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | OOS (2023-2024) | 3d | 4.2% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | OOS (2023-2024) | 5d | 4.2% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | FWD (2025-present) | 1d | 28.6% | 0.8% | 1% | +0pp | 33% | 2% | 1.0d | 99.0% | WEAK |
| v2 | FWD (2025-present) | 3d | 28.6% | 0.8% | 3% | +2pp | 33% | 5% | 2.0d | 97.1% | WEAK |
| v2 | FWD (2025-present) | 5d | 28.6% | 0.8% | 3% | +2pp | 33% | 5% | 2.0d | 97.1% | WEAK |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v3 | IS (2015-2022) | 1d | 21.1% | 1.7% | 1% | +-0pp | 17% | 2% | 1.0d | 98.7% | WEAK |
| v3 | IS (2015-2022) | 3d | 21.1% | 1.7% | 4% | +2pp | 23% | 6% | 3.0d | 96.5% | WEAK |
| v3 | IS (2015-2022) | 5d | 21.1% | 1.7% | 5% | +3pp | 23% | 8% | 4.0d | 94.9% | WEAK |
| v3 | OOS (2023-2024) | 1d | 4.8% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | OOS (2023-2024) | 3d | 4.8% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | OOS (2023-2024) | 5d | 4.8% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | FWD (2025-present) | 1d | 27.7% | 0.8% | 1% | +0pp | 33% | 2% | 1.0d | 99.0% | WEAK |
| v3 | FWD (2025-present) | 3d | 27.7% | 0.8% | 3% | +2pp | 33% | 6% | 2.0d | 97.0% | WEAK |
| v3 | FWD (2025-present) | 5d | 27.7% | 0.8% | 3% | +2pp | 33% | 6% | 2.0d | 97.0% | WEAK |

### EXTREME only -> SPY <= -1.5%

| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |
|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|
| v1 | IS (2015-2022) | 1d | 12.2% | 6.9% | 9% | +2pp | 16% | 11% | 1.0d | 91.2% | WEAK |
| v1 | IS (2015-2022) | 3d | 12.2% | 6.9% | 20% | +13pp | 19% | 19% | 2.0d | 80.0% | MIXED |
| v1 | IS (2015-2022) | 5d | 12.2% | 6.9% | 29% | +22pp | 22% | 25% | 4.0d | 70.7% | MIXED |
| v1 | OOS (2023-2024) | 1d | 0.6% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v1 | OOS (2023-2024) | 3d | 0.6% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v1 | OOS (2023-2024) | 5d | 0.6% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v1 | FWD (2025-present) | 1d | 13.4% | 6.7% | 6% | +-1pp | 12% | 8% | 1.0d | 93.8% | WEAK |
| v1 | FWD (2025-present) | 3d | 13.4% | 6.7% | 15% | +8pp | 12% | 14% | 2.0d | 85.4% | MIXED |
| v1 | FWD (2025-present) | 5d | 13.4% | 6.7% | 17% | +10pp | 12% | 14% | 3.0d | 83.3% | MIXED |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v2 | IS (2015-2022) | 1d | 12.5% | 6.9% | 10% | +3pp | 17% | 12% | 1.0d | 90.5% | WEAK |
| v2 | IS (2015-2022) | 3d | 12.5% | 6.9% | 22% | +15pp | 18% | 20% | 2.0d | 77.7% | MIXED |
| v2 | IS (2015-2022) | 5d | 12.5% | 6.9% | 30% | +24pp | 20% | 24% | 3.0d | 69.5% | MIXED |
| v2 | OOS (2023-2024) | 1d | 1.4% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v2 | OOS (2023-2024) | 3d | 1.4% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v2 | OOS (2023-2024) | 5d | 1.4% | 3.2% | 0% | +-3pp | 0% | n/a | n/ad | 100.0% | WEAK |
| v2 | FWD (2025-present) | 1d | 14.6% | 6.7% | 10% | +3pp | 21% | 13% | 1.0d | 90.4% | WEAK |
| v2 | FWD (2025-present) | 3d | 14.6% | 6.7% | 21% | +14pp | 25% | 23% | 2.0d | 78.8% | MIXED |
| v2 | FWD (2025-present) | 5d | 14.6% | 6.7% | 27% | +20pp | 25% | 26% | 3.0d | 73.1% | MIXED |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v3 | IS (2015-2022) | 1d | 9.0% | 6.9% | 5% | +-2pp | 7% | 6% | 1.0d | 94.9% | WEAK |
| v3 | IS (2015-2022) | 3d | 9.0% | 6.9% | 18% | +11pp | 11% | 13% | 3.0d | 82.3% | MIXED |
| v3 | IS (2015-2022) | 5d | 9.0% | 6.9% | 27% | +20pp | 14% | 18% | 4.0d | 73.4% | MIXED |
| v3 | OOS (2023-2024) | 1d | 2.4% | 3.2% | 8% | +5pp | 6% | 7% | 4.0d | 91.7% | MIXED |
| v3 | OOS (2023-2024) | 3d | 2.4% | 3.2% | 42% | +38pp | 12% | 19% | 4.0d | 58.3% | USEFUL |
| v3 | OOS (2023-2024) | 5d | 2.4% | 3.2% | 58% | +55pp | 12% | 21% | 5.0d | 41.7% | USEFUL |
| v3 | FWD (2025-present) | 1d | 9.0% | 6.7% | 12% | +6pp | 17% | 14% | 1.0d | 87.5% | MIXED |
| v3 | FWD (2025-present) | 3d | 9.0% | 6.7% | 25% | +18pp | 17% | 20% | 2.0d | 75.0% | MIXED |
| v3 | FWD (2025-present) | 5d | 9.0% | 6.7% | 28% | +21pp | 17% | 21% | 2.0d | 71.9% | MIXED |

### EXTREME only -> SPY <= -3%

| Model | Period | Look | Sig% | Ev% | Prec | vsRand | Recall | F1 | Lead | FP% | Verdict |
|-------|--------|-----:|-----:|----:|-----:|-------:|-------:|---:|-----:|----:|---------|
| v1 | IS (2015-2022) | 1d | 12.2% | 1.7% | 2% | +0pp | 13% | 3% | 1.0d | 98.1% | WEAK |
| v1 | IS (2015-2022) | 3d | 12.2% | 1.7% | 3% | +2pp | 13% | 5% | 1.0d | 96.7% | WEAK |
| v1 | IS (2015-2022) | 5d | 12.2% | 1.7% | 5% | +3pp | 17% | 7% | 3.0d | 95.3% | WEAK |
| v1 | OOS (2023-2024) | 1d | 0.6% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | OOS (2023-2024) | 3d | 0.6% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | OOS (2023-2024) | 5d | 0.6% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v1 | FWD (2025-present) | 1d | 13.4% | 0.8% | 2% | +1pp | 33% | 4% | 1.0d | 97.9% | WEAK |
| v1 | FWD (2025-present) | 3d | 13.4% | 0.8% | 4% | +3pp | 33% | 7% | 1.5d | 95.8% | WEAK |
| v1 | FWD (2025-present) | 5d | 13.4% | 0.8% | 4% | +3pp | 33% | 7% | 1.5d | 95.8% | WEAK |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v2 | IS (2015-2022) | 1d | 12.5% | 1.7% | 3% | +2pp | 23% | 6% | 1.0d | 96.8% | WEAK |
| v2 | IS (2015-2022) | 3d | 12.5% | 1.7% | 6% | +5pp | 23% | 10% | 2.0d | 93.6% | WEAK |
| v2 | IS (2015-2022) | 5d | 12.5% | 1.7% | 8% | +6pp | 23% | 12% | 2.5d | 91.8% | MIXED |
| v2 | OOS (2023-2024) | 1d | 1.4% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | OOS (2023-2024) | 3d | 1.4% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | OOS (2023-2024) | 5d | 1.4% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v2 | FWD (2025-present) | 1d | 14.6% | 0.8% | 2% | +1pp | 33% | 4% | 1.0d | 98.1% | WEAK |
| v2 | FWD (2025-present) | 3d | 14.6% | 0.8% | 4% | +3pp | 33% | 7% | 1.5d | 96.2% | WEAK |
| v2 | FWD (2025-present) | 5d | 14.6% | 0.8% | 4% | +3pp | 33% | 7% | 1.5d | 96.2% | WEAK |
|  |  |  |  |  |  |  |  |  |  |  |  |
| v3 | IS (2015-2022) | 1d | 9.0% | 1.7% | 1% | +-1pp | 3% | 1% | 1.0d | 99.4% | WEAK |
| v3 | IS (2015-2022) | 3d | 9.0% | 1.7% | 3% | +2pp | 7% | 4% | 3.0d | 96.8% | WEAK |
| v3 | IS (2015-2022) | 5d | 9.0% | 1.7% | 4% | +2pp | 10% | 6% | 3.5d | 96.2% | WEAK |
| v3 | OOS (2023-2024) | 1d | 2.4% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | OOS (2023-2024) | 3d | 2.4% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | OOS (2023-2024) | 5d | 2.4% | 0.0% | 0% | +0pp | n/a | n/a | n/ad | 100.0% | NO_DATA |
| v3 | FWD (2025-present) | 1d | 9.0% | 0.8% | 3% | +2pp | 33% | 6% | 1.0d | 96.9% | WEAK |
| v3 | FWD (2025-present) | 3d | 9.0% | 0.8% | 9% | +9pp | 33% | 15% | 2.0d | 90.6% | MIXED |
| v3 | FWD (2025-present) | 5d | 9.0% | 0.8% | 9% | +9pp | 33% | 15% | 2.0d | 90.6% | MIXED |

---

## 3. Current Signal -- Last 10 Trading Days

| Model | Date | Signal | Rank |
|-------|------|--------|-----:|
| v1 | 2026-05-22 | EXTREME | 3 | **<--**
| v1 | 2026-05-26 | EXTREME | 3 | **<--**
| v1 | 2026-05-27 | EXTREME | 3 | **<--**
| v1 | 2026-05-28 | EXTREME | 3 | **<--**
| v1 | 2026-05-29 | SPIKE | 2 | **<--**
| v1 | 2026-06-01 | SPIKE | 2 | **<--**
| v1 | 2026-06-02 | SPIKE | 2 | **<--**
| v1 | 2026-06-03 | CAUTION | 1 | *
| v1 | 2026-06-04 | CAUTION | 1 | *
| v1 | 2026-06-05 | SPIKE | 2 | **<--**
| v2 | 2026-05-22 | EXTREME | 3 | **<--**
| v2 | 2026-05-26 | EXTREME | 3 | **<--**
| v2 | 2026-05-27 | EXTREME | 3 | **<--**
| v2 | 2026-05-28 | EXTREME | 3 | **<--**
| v2 | 2026-05-29 | SPIKE | 2 | **<--**
| v2 | 2026-06-01 | SPIKE | 2 | **<--**
| v2 | 2026-06-02 | SPIKE | 2 | **<--**
| v2 | 2026-06-03 | CAUTION | 1 | *
| v2 | 2026-06-04 | CAUTION | 1 | *
| v2 | 2026-06-05 | SPIKE | 2 | **<--**
| v3 | 2026-05-22 | SPIKE | 2 | **<--**
| v3 | 2026-05-26 | SPIKE | 2 | **<--**
| v3 | 2026-05-27 | SPIKE | 2 | **<--**
| v3 | 2026-05-28 | SPIKE | 2 | **<--**
| v3 | 2026-05-29 | SPIKE | 2 | **<--**
| v3 | 2026-06-01 | SPIKE | 2 | **<--**
| v3 | 2026-06-02 | SPIKE | 2 | **<--**
| v3 | 2026-06-03 | SPIKE | 2 | **<--**
| v3 | 2026-06-04 | SPIKE | 2 | **<--**
| v3 | 2026-06-05 | SPIKE | 2 | **<--**

---

## 4. Historical Event Backtest (16 events)

| Event | Date | Cat | v1 | v2 | v3 | Verdict |
|-------|------|-----|-----|-----|-----|---------|
| GFC Lehman Collapse | 2008-09-15 | SYSTEMIC | FAIL(NORMAL) | FAIL(NORMAL) | FAIL(NORMAL) | FAIL |
| Dot-com Peak | 2000-03-10 | CONTAGION | PASS(CAUTION) | FAIL(NORMAL) | PASS(CAUTION) | PASS |
| 9/11 Market Reopening | 2001-09-17 | SUDDEN | MISS(ok)(EXTREME) | MISS(ok)(EXTREME) | MISS(ok)(SPIKE) | MISS(ok) |
| Eurozone Crisis / S&P Downgrade | 2011-08-08 | SYSTEMIC | PASS(EXTREME) | PASS(EXTREME) | PASS(SPIKE) | PASS |
| Flash Crash 2010 | 2010-05-06 | SUDDEN | MISS(ok)(CAUTION) | MISS(ok)(CAUTION) | MISS(ok)(CAUTION) | MISS(ok) |
| China Devaluation 2015 | 2015-08-11 | CONTAGION | PASS(CAUTION) | FAIL(NORMAL) | PASS(CAUTION) | PASS |
| Flash Crash 2015 (ETF) | 2015-08-24 | SUDDEN | MISS(ok)(NORMAL) | MISS(ok)(NORMAL) | MISS(ok)(NORMAL) | MISS(ok) |
| Volmageddon (XIV Collapse) | 2018-02-05 | SYSTEMIC | PASS(CAUTION) | PASS(CAUTION) | PASS(CAUTION) | PASS |
| Q4 2018 Fed Rate Selloff | 2018-12-24 | SYSTEMIC | PASS(EXTREME) | PASS(SPIKE) | PASS(SPIKE) | PASS |
| Repo Market Stress 2019 | 2019-09-17 | SUDDEN | MISS(ok)(EXTREME) | MISS(ok)(EXTREME) | MISS(ok)(EXTREME) | MISS(ok) |
| COVID Crash 2020 | 2020-02-24 | SYSTEMIC | PASS(EXTREME) | PASS(EXTREME) | PASS(EXTREME) | PASS |
| Russia Invades Ukraine | 2022-02-24 | SUDDEN | MISS(ok)(EXTREME) | MISS(ok)(SPIKE) | MISS(ok)(SPIKE) | MISS(ok) |
| 2022 Fed Rate Shock | 2022-01-18 | SYSTEMIC | PASS(CAUTION) | FAIL(NORMAL) | PASS(SPIKE) | PASS |
| SVB Collapse | 2023-03-10 | CONTAGION | PASS(CAUTION) | PASS(CAUTION) | PASS(CAUTION) | PASS |
| Yen Carry Unwind 2024 | 2024-08-05 | SUDDEN | MISS(ok)(CAUTION) | MISS(ok)(CAUTION) | MISS(ok)(CAUTION) | MISS(ok) |
| Apr 2025 Tariff Shock | 2025-04-07 | SYSTEMIC | FAIL(NORMAL) | FAIL(NORMAL) | PASS(CAUTION) | FAIL |

**v1:** 8/10  **v2:** 5/10  **v3 (active):** 9/10

> v1 is production model. v2 needs MLE calibration to beat v1 consistently.
> v3 HMM adds orthogonal regime signal; strongest in identifying corr-regime shifts.

---

## 5. Summary Findings

| Aspect | v1 (symmetric) | v2 (A-DCC) | v3 (HMM) |
|--------|---------------|-----------|----------|
| Event detection | 8/10 | 5/10 | 9/10 |
| Gradual selloffs | Strong (Dot-com, China 2015, 2022 Rate) | Weaker (alpha too slow) | Strong (regime shift) |
| Pure panic crashes | Strong | Stronger (+gamma) | Depends on IS fit |
| False positive rate | High (~49% IS sig rate) | Similar to v1 | Varies by threshold |
| Best use | Primary signal | Supplementary crash amplifier | Regime context |
| Current signal | See §3 | See §3 | See §3 |

---
_Generated by backtest/02_dcc_correlation_monitor/run.py | 2026-06-07_