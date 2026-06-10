# Full Project Signal Backtest Report
**Generated:** 2026-06-06  
**Scope:** All detection mechanisms in bloomberg-terminal project  
**Event:** SPY daily return ≤ threshold  
**Signal evaluation:** signal fires at T, event at T+1..T+lookahead  

---

## Signal Groups Tested

- **g1**: **VIX-based** — Volatility regime indicators
- **g2**: **Credit Spreads** — Spread vs threshold + z-score (crisis.py)
- **g3**: **Financial Stress** — STL FSI, Chicago NFCI (crisis.py)
- **g4**: **Yield Curve** — 10Y-2Y, 10Y-3M inversions
- **g5**: **Fear & Greed** — Synthetic 5-component composite (fear_greed.py)
- **g6**: **Sector Regime** — 11-sector rolling correlation convergence (regime.py)
- **g7**: **Equity Technicals** — RSI oversold, price z-score
- **g8**: **Allocation Layer A** — SPY vs AGG 20d relative z-score (layer_a.py)
- **g9**: **Crisis Composite** — Weighted composite score RED (crisis.py /composite)
- **g10**: **Volume / Flow** — SPY volume z-score anomaly
- **g11**: **Cross-Asset** — Safe haven flight, correlation velocity
- **g12**: **Composite Gate** — 3+ signals active simultaneously

---

## How to Read

- **Precision** = % of signal fires followed by fat tail within lookahead
- **vs Rand** = edge over baseline (event_rate × window) — the real test
- **Recall** = % of fat tails preceded by signal within window
- **STRONG** = precision≥50% AND recall≥45%
- **USEFUL** = precision≥35% AND edge≥15pp
- **SENSITIVE** = recall≥55% but precision lower (noisy but catches events)
- **WEAK** = edge < 5pp (random noise)
- **NO_EVENTS** = no events in this period at this threshold

---

## 1. In-Sample (2015–2022)
_Includes: 2015 China flash crash, 2018 vol spike, 2018 Q4 correction, 2020 COVID_

### 1.x SPY ≤ -1.5% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 112 | 39% | +20pp | 29% | 34% | 2.5d | 🟡 USEFUL |
| `g11_corr_velocity` | 266 | 19% | +0pp | 24% | 21% | 3.0d | ❌ WEAK |
| `g11_safe_haven` | 349 | 20% | +1pp | 50% | 29% | 2.0d | ❌ WEAK |
| `g12_composite` | 697 | 34% | +15pp | 81% | 48% | 2.0d | 🟡 SENSITIVE |
| `g1_vix_backwardation` | 513 | 37% | +19pp | 72% | 49% | 2.0d | 🟡 USEFUL |
| `g1_vix_momentum` | 215 | 37% | +18pp | 40% | 39% | 3.0d | 🟡 USEFUL |
| `g1_vix_spike` | 343 | 38% | +19pp | 55% | 45% | 2.0d | 🟡 USEFUL |
| `g3_nfci` | 36 | 56% | +37pp | 8% | 14% | 2.0d | 🟡 USEFUL |
| `g3_stl_fsi` | 576 | 25% | +6pp | 46% | 32% | 2.0d | ⚠️ MIXED |
| `g4_yc_10y2y` | 130 | 30% | +11pp | 10% | 15% | 2.0d | ⚠️ MIXED |
| `g4_yc_10y3m` | 165 | 24% | +5pp | 11% | 15% | 3.0d | ❌ WEAK |
| `g5_fg_extreme_fear` | 251 | 43% | +24pp | 38% | 40% | 2.0d | 🟡 USEFUL |
| `g5_fg_fear_zone` | 812 | 27% | +8pp | 71% | 39% | 2.0d | 🟡 SENSITIVE |
| `g6_sector_convergent` | 561 | 29% | +10pp | 50% | 37% | 2.0d | ⚠️ MIXED |
| `g7_price_zscore` | 1974 | 17% | -2pp | 99% | 29% | 2.0d | ❌ WEAK |
| `g7_rsi_oversold` | 192 | 38% | +19pp | 35% | 36% | 2.0d | 🟡 USEFUL |
| `g8_layer_a_bearish` | 598 | 30% | +11pp | 62% | 40% | 2.0d | 🟡 SENSITIVE |
| `g9_crisis_composite_red` | 8 | 100% | +81pp | 4% | 8% | 2.0d | 🟡 USEFUL |

### 1.x SPY ≤ -3% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 112 | 18% | +13pp | 53% | 27% | 3.0d | ⚠️ MIXED |
| `g11_corr_velocity` | 266 | 6% | +2pp | 34% | 11% | 3.0d | ❌ WEAK |
| `g11_safe_haven` | 349 | 6% | +2pp | 62% | 11% | 2.0d | ❌ WEAK |
| `g12_composite` | 697 | 9% | +4pp | 91% | 16% | 2.0d | ❌ WEAK |
| `g1_vix_backwardation` | 513 | 12% | +7pp | 88% | 21% | 2.0d | ⚠️ MIXED |
| `g1_vix_momentum` | 215 | 15% | +11pp | 56% | 24% | 2.0d | ⚠️ MIXED |
| `g1_vix_spike` | 343 | 15% | +10pp | 78% | 25% | 2.0d | ⚠️ MIXED |
| `g3_nfci` | 36 | 28% | +23pp | 16% | 20% | 2.0d | ⚠️ MIXED |
| `g3_stl_fsi` | 576 | 6% | +1pp | 50% | 11% | 2.0d | ❌ WEAK |
| `g4_yc_10y2y` | 130 | 5% | -0pp | 6% | 5% | 2.5d | ❌ WEAK |
| `g4_yc_10y3m` | 165 | 6% | +1pp | 16% | 9% | 3.0d | ❌ WEAK |
| `g5_fg_extreme_fear` | 251 | 11% | +6pp | 41% | 17% | 2.0d | ⚠️ MIXED |
| `g5_fg_fear_zone` | 812 | 7% | +2pp | 78% | 13% | 2.0d | ❌ WEAK |
| `g6_sector_convergent` | 561 | 8% | +3pp | 59% | 14% | 2.0d | ❌ WEAK |
| `g7_price_zscore` | 1974 | 4% | -1pp | 100% | 8% | 2.0d | ❌ WEAK |
| `g7_rsi_oversold` | 192 | 13% | +8pp | 47% | 20% | 2.0d | ⚠️ MIXED |
| `g8_layer_a_bearish` | 598 | 8% | +3pp | 69% | 14% | 2.0d | ❌ WEAK |
| `g9_crisis_composite_red` | 8 | 75% | +70pp | 12% | 21% | 2.0d | 🟡 USEFUL |

### 1.x SPY ≤ -5% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 112 | 4% | +3pp | 60% | 7% | 3.0d | ❌ WEAK |
| `g11_corr_velocity` | 266 | 1% | +0pp | 40% | 1% | 3.5d | ❌ WEAK |
| `g11_safe_haven` | 349 | 1% | +1pp | 60% | 3% | 3.0d | ❌ WEAK |
| `g12_composite` | 697 | 1% | +1pp | 80% | 3% | 3.0d | ❌ WEAK |
| `g1_vix_backwardation` | 513 | 2% | +1pp | 80% | 4% | 3.0d | ❌ WEAK |
| `g1_vix_momentum` | 215 | 3% | +3pp | 60% | 6% | 2.0d | ❌ WEAK |
| `g1_vix_spike` | 343 | 3% | +2pp | 80% | 6% | 3.0d | ❌ WEAK |
| `g3_nfci` | 36 | 8% | +8pp | 40% | 14% | 2.0d | ⚠️ MIXED |
| `g3_stl_fsi` | 576 | 2% | +1pp | 80% | 3% | 3.0d | ❌ WEAK |
| `g4_yc_10y2y` | 130 | 0% | -1pp | 0% | 0% | n/ad | ❌ WEAK |
| `g4_yc_10y3m` | 165 | 0% | -1pp | 0% | 0% | n/ad | ❌ WEAK |
| `g5_fg_extreme_fear` | 251 | 4% | +3pp | 80% | 8% | 3.0d | ❌ WEAK |
| `g5_fg_fear_zone` | 812 | 1% | +0pp | 80% | 2% | 3.0d | ❌ WEAK |
| `g6_sector_convergent` | 561 | 2% | +2pp | 100% | 5% | 3.0d | ❌ WEAK |
| `g7_price_zscore` | 1974 | 1% | -0pp | 100% | 1% | 2.0d | ❌ WEAK |
| `g7_rsi_oversold` | 192 | 5% | +4pp | 80% | 9% | 3.0d | ❌ WEAK |
| `g8_layer_a_bearish` | 598 | 2% | +1pp | 80% | 3% | 3.0d | ❌ WEAK |
| `g9_crisis_composite_red` | 8 | 38% | +37pp | 40% | 39% | 2.0d | 🟡 USEFUL |

### In-Sample L1: Lookahead 1 / 5 days comparison

**1-day lookahead:**
| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 112 | 21% | +14pp | 17% | 19% | 1.0d | ⚠️ MIXED |
| `g11_corr_velocity` | 266 | 7% | +0pp | 14% | 9% | 1.0d | ❌ WEAK |
| `g11_safe_haven` | 349 | 8% | +2pp | 21% | 12% | 1.0d | ❌ WEAK |
| `g12_composite` | 697 | 14% | +8pp | 74% | 24% | 1.0d | ⚠️ MIXED |
| `g1_vix_backwardation` | 513 | 15% | +8pp | 57% | 24% | 1.0d | ⚠️ MIXED |
| `g1_vix_momentum` | 215 | 14% | +7pp | 22% | 17% | 1.0d | ⚠️ MIXED |
| `g1_vix_spike` | 343 | 16% | +9pp | 40% | 23% | 1.0d | ⚠️ MIXED |
| `g3_nfci` | 36 | 25% | +18pp | 7% | 10% | 1.0d | ⚠️ MIXED |
| `g3_stl_fsi` | 576 | 11% | +4pp | 45% | 17% | 1.0d | ❌ WEAK |
| `g4_yc_10y2y` | 130 | 11% | +4pp | 10% | 11% | 1.0d | ❌ WEAK |
| `g4_yc_10y3m` | 165 | 8% | +2pp | 10% | 9% | 1.0d | ❌ WEAK |
| `g5_fg_extreme_fear` | 251 | 19% | +12pp | 35% | 24% | 1.0d | ⚠️ MIXED |
| `g5_fg_fear_zone` | 812 | 11% | +4pp | 65% | 19% | 1.0d | ❌ WEAK |
| `g6_sector_convergent` | 561 | 12% | +5pp | 49% | 19% | 1.0d | ⚠️ MIXED |
| `g7_price_zscore` | 1974 | 7% | -0pp | 95% | 12% | 1.0d | ❌ WEAK |
| `g7_rsi_oversold` | 192 | 18% | +11pp | 25% | 21% | 1.0d | ⚠️ MIXED |
| `g8_layer_a_bearish` | 598 | 13% | +6pp | 56% | 21% | 1.0d | ⚠️ MIXED |
| `g9_crisis_composite_red` | 8 | 38% | +31pp | 2% | 4% | 1.0d | 🟡 USEFUL |

**5-day lookahead:**
| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 112 | 51% | +21pp | 39% | 44% | 3.0d | 🟡 USEFUL |
| `g11_corr_velocity` | 266 | 24% | -5pp | 32% | 28% | 3.0d | ❌ WEAK |
| `g11_safe_haven` | 349 | 28% | -2pp | 65% | 39% | 3.0d | 🟡 SENSITIVE |
| `g12_composite` | 697 | 46% | +16pp | 85% | 60% | 3.0d | 🟡 USEFUL |
| `g1_vix_backwardation` | 513 | 50% | +21pp | 77% | 61% | 3.0d | ✅ STRONG |
| `g1_vix_momentum` | 215 | 46% | +17pp | 49% | 47% | 3.0d | 🟡 USEFUL |
| `g1_vix_spike` | 343 | 51% | +22pp | 66% | 58% | 3.0d | ✅ STRONG |
| `g3_nfci` | 36 | 75% | +45pp | 9% | 16% | 3.0d | 🟡 USEFUL |
| `g3_stl_fsi` | 576 | 34% | +4pp | 50% | 40% | 3.0d | ❌ WEAK |
| `g4_yc_10y2y` | 130 | 48% | +18pp | 11% | 18% | 4.0d | 🟡 USEFUL |
| `g4_yc_10y3m` | 165 | 36% | +6pp | 12% | 19% | 5.0d | ⚠️ MIXED |
| `g5_fg_extreme_fear` | 251 | 54% | +25pp | 38% | 45% | 3.0d | 🟡 USEFUL |
| `g5_fg_fear_zone` | 812 | 37% | +7pp | 74% | 49% | 3.0d | 🟡 SENSITIVE |
| `g6_sector_convergent` | 561 | 40% | +11pp | 51% | 45% | 3.0d | ⚠️ MIXED |
| `g7_price_zscore` | 1974 | 24% | -5pp | 99% | 39% | 3.0d | 🟡 SENSITIVE |
| `g7_rsi_oversold` | 192 | 57% | +27pp | 46% | 51% | 3.0d | ✅ STRONG |
| `g8_layer_a_bearish` | 598 | 41% | +12pp | 68% | 52% | 3.0d | 🟡 SENSITIVE |
| `g9_crisis_composite_red` | 8 | 100% | +70pp | 4% | 8% | 2.0d | 🟡 USEFUL |

---

## 2. Out-of-Sample (2023–2024)
_Includes: SVB Mar 2023, regional banking stress, Aug 2024 yen carry unwind_
_Note: 2023-2024 was a bull market — L2/L3 events rare or absent_

### 2.x SPY ≤ -1.5% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 20 | 10% | +1pp | 12% | 11% | 2.0d | ❌ WEAK |
| `g11_corr_velocity` | 83 | 11% | +2pp | 25% | 15% | 4.0d | ❌ WEAK |
| `g11_safe_haven` | 53 | 17% | +8pp | 50% | 25% | 2.0d | ⚠️ MIXED |
| `g12_composite` | 97 | 10% | +1pp | 38% | 16% | 2.0d | ❌ WEAK |
| `g1_vix_backwardation` | 131 | 15% | +5pp | 56% | 23% | 2.0d | ⚠️ MIXED |
| `g1_vix_momentum` | 41 | 12% | +3pp | 25% | 16% | 3.0d | ❌ WEAK |
| `g1_vix_spike` | 55 | 5% | -4pp | 19% | 8% | 3.0d | ❌ WEAK |
| `g2_hy_static` | 0 | 0% | -9pp | 0% | 0% | n/ad | ❌ WEAK |
| `g2_hy_zscore` | 0 | 0% | -9pp | 0% | 0% | n/ad | ❌ WEAK |
| `g2_ig_static` | 0 | 0% | -9pp | 0% | 0% | n/ad | ❌ WEAK |
| `g3_nfci` | 0 | 0% | -9pp | 0% | 0% | n/ad | ❌ WEAK |
| `g3_stl_fsi` | 10 | 30% | +21pp | 6% | 10% | 2.0d | ⚠️ MIXED |
| `g4_yc_10y2y` | 416 | 8% | -1pp | 81% | 15% | 3.0d | ❌ WEAK |
| `g4_yc_10y3m` | 490 | 9% | -1pp | 94% | 16% | 3.0d | ❌ WEAK |
| `g5_fg_extreme_fear` | 15 | 7% | -3pp | 6% | 6% | 3.0d | ❌ WEAK |
| `g5_fg_fear_zone` | 107 | 11% | +2pp | 31% | 17% | 3.0d | ❌ WEAK |
| `g6_sector_convergent` | 11 | 18% | +9pp | 6% | 9% | 4.5d | ⚠️ MIXED |
| `g7_price_zscore` | 486 | 9% | -1pp | 94% | 16% | 2.5d | ❌ WEAK |
| `g7_rsi_oversold` | 48 | 12% | +3pp | 31% | 18% | 2.5d | ❌ WEAK |
| `g8_layer_a_bearish` | 87 | 9% | -0pp | 25% | 13% | 3.0d | ❌ WEAK |
| `g9_crisis_composite_red` | 0 | 0% | -9pp | 0% | 0% | n/ad | ❌ WEAK |

### 2.x SPY ≤ -3% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 20 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g11_corr_velocity` | 83 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g11_safe_haven` | 53 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g12_composite` | 97 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g1_vix_backwardation` | 131 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g1_vix_momentum` | 41 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g1_vix_spike` | 55 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g2_hy_static` | 0 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g2_hy_zscore` | 0 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g2_ig_static` | 0 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g3_nfci` | 0 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g3_stl_fsi` | 10 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g4_yc_10y2y` | 416 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g4_yc_10y3m` | 490 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g5_fg_extreme_fear` | 15 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g5_fg_fear_zone` | 107 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g6_sector_convergent` | 11 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g7_price_zscore` | 486 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g7_rsi_oversold` | 48 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g8_layer_a_bearish` | 87 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |
| `g9_crisis_composite_red` | 0 | 0% | +0pp | 0% | 0% | n/ad | — NO_EVENTS |

---

## 3. Forward Test (2025–Present)
_Live signals computed on actual 2025-2026 data_

### 3.x SPY ≤ -1.5% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 20 | 50% | +31pp | 33% | 40% | 2.0d | 🟡 USEFUL |
| `g11_corr_velocity` | 53 | 23% | +4pp | 29% | 25% | 2.0d | ❌ WEAK |
| `g11_safe_haven` | 42 | 21% | +3pp | 33% | 26% | 3.0d | ❌ WEAK |
| `g12_composite` | 79 | 39% | +20pp | 58% | 47% | 2.0d | 🟡 USEFUL |
| `g1_vix_backwardation` | 68 | 41% | +22pp | 54% | 47% | 2.0d | 🟡 USEFUL |
| `g1_vix_momentum` | 35 | 49% | +30pp | 42% | 45% | 2.0d | 🟡 USEFUL |
| `g1_vix_spike` | 52 | 40% | +22pp | 50% | 45% | 2.0d | 🟡 USEFUL |
| `g2_hy_static` | 0 | 0% | -19pp | 0% | 0% | n/ad | ❌ WEAK |
| `g2_hy_zscore` | 0 | 0% | -19pp | 0% | 0% | n/ad | ❌ WEAK |
| `g2_ig_static` | 0 | 0% | -19pp | 0% | 0% | n/ad | ❌ WEAK |
| `g3_nfci` | 0 | 0% | -19pp | 0% | 0% | n/ad | ❌ WEAK |
| `g3_stl_fsi` | 11 | 82% | +63pp | 17% | 28% | 2.0d | 🟡 USEFUL |
| `g4_yc_10y2y` | 0 | 0% | -19pp | 0% | 0% | n/ad | ❌ WEAK |
| `g4_yc_10y3m` | 86 | 24% | +6pp | 46% | 32% | 2.0d | ⚠️ MIXED |
| `g5_fg_extreme_fear` | 20 | 15% | -4pp | 4% | 7% | 2.0d | ❌ WEAK |
| `g5_fg_fear_zone` | 105 | 15% | -4pp | 25% | 19% | 2.0d | ❌ WEAK |
| `g6_sector_convergent` | 24 | 38% | +19pp | 17% | 23% | 2.0d | 🟡 USEFUL |
| `g7_price_zscore` | 341 | 17% | -2pp | 96% | 29% | 2.0d | ❌ WEAK |
| `g7_rsi_oversold` | 30 | 47% | +28pp | 33% | 39% | 2.5d | 🟡 USEFUL |
| `g8_layer_a_bearish` | 73 | 30% | +11pp | 46% | 36% | 2.0d | ⚠️ MIXED |
| `g9_crisis_composite_red` | 0 | 0% | -19pp | 0% | 0% | n/ad | ❌ WEAK |

### 3.x SPY ≤ -3% — Lookahead 3 days

| Signal | Fires | Precision | vs Rand | Recall | F1 | Lead(med) | Verdict |
|--------|------:|----------:|--------:|-------:|---:|----------:|---------|
| `g10_volume_surge` | 20 | 20% | +18pp | 67% | 31% | 1.5d | 🟡 SENSITIVE |
| `g11_corr_velocity` | 53 | 6% | +3pp | 33% | 10% | 2.0d | ❌ WEAK |
| `g11_safe_haven` | 42 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g12_composite` | 79 | 9% | +6pp | 100% | 16% | 2.0d | ⚠️ MIXED |
| `g1_vix_backwardation` | 68 | 10% | +8pp | 100% | 19% | 2.0d | ⚠️ MIXED |
| `g1_vix_momentum` | 35 | 17% | +15pp | 100% | 29% | 2.0d | ⚠️ MIXED |
| `g1_vix_spike` | 52 | 8% | +5pp | 67% | 14% | 1.5d | ⚠️ MIXED |
| `g2_hy_static` | 0 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g2_hy_zscore` | 0 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g2_ig_static` | 0 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g3_nfci` | 0 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g3_stl_fsi` | 11 | 27% | +25pp | 33% | 30% | 2.0d | ⚠️ MIXED |
| `g4_yc_10y2y` | 0 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g4_yc_10y3m` | 86 | 8% | +6pp | 100% | 15% | 2.0d | ⚠️ MIXED |
| `g5_fg_extreme_fear` | 20 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g5_fg_fear_zone` | 105 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |
| `g6_sector_convergent` | 24 | 12% | +10pp | 33% | 18% | 2.0d | ⚠️ MIXED |
| `g7_price_zscore` | 341 | 2% | -1pp | 100% | 3% | 2.0d | ❌ WEAK |
| `g7_rsi_oversold` | 30 | 7% | +4pp | 33% | 11% | 2.5d | ❌ WEAK |
| `g8_layer_a_bearish` | 73 | 8% | +6pp | 100% | 15% | 1.5d | ⚠️ MIXED |
| `g9_crisis_composite_red` | 0 | 0% | -2pp | 0% | 0% | n/ad | ❌ WEAK |

---

## 4. Signal Verdict Summary (L1, 3-day, across all periods)

| Signal | In-sample | OOS | Forward | Consistent? |
|--------|-----------|-----|---------|-------------|
| `g10_volume_surge` | 🟡 USEFUL | ❌ WEAK | 🟡 USEFUL | ✅ YES |
| `g11_corr_velocity` | ❌ WEAK | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g11_safe_haven` | ❌ WEAK | ⚠️ MIXED | ❌ WEAK | ❌ NO |
| `g12_composite` | 🟡 SENSITIVE | ❌ WEAK | 🟡 USEFUL | 🟡 PARTIAL |
| `g1_vix_backwardation` | 🟡 USEFUL | ⚠️ MIXED | 🟡 USEFUL | ✅ YES |
| `g1_vix_momentum` | 🟡 USEFUL | ❌ WEAK | 🟡 USEFUL | ✅ YES |
| `g1_vix_spike` | 🟡 USEFUL | ❌ WEAK | 🟡 USEFUL | ✅ YES |
| `g2_hy_static` | — | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g2_hy_zscore` | — | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g2_ig_static` | — | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g3_nfci` | 🟡 USEFUL | ❌ WEAK | ❌ WEAK | 🟡 PARTIAL |
| `g3_stl_fsi` | ⚠️ MIXED | ⚠️ MIXED | 🟡 USEFUL | 🟡 PARTIAL |
| `g4_yc_10y2y` | ⚠️ MIXED | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g4_yc_10y3m` | ❌ WEAK | ❌ WEAK | ⚠️ MIXED | ❌ NO |
| `g5_fg_extreme_fear` | 🟡 USEFUL | ❌ WEAK | ❌ WEAK | 🟡 PARTIAL |
| `g5_fg_fear_zone` | 🟡 SENSITIVE | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g6_sector_convergent` | ⚠️ MIXED | ⚠️ MIXED | 🟡 USEFUL | 🟡 PARTIAL |
| `g7_price_zscore` | ❌ WEAK | ❌ WEAK | ❌ WEAK | ❌ NO |
| `g7_rsi_oversold` | 🟡 USEFUL | ❌ WEAK | 🟡 USEFUL | ✅ YES |
| `g8_layer_a_bearish` | 🟡 SENSITIVE | ❌ WEAK | ⚠️ MIXED | ❌ NO |
| `g9_crisis_composite_red` | 🟡 USEFUL | ❌ WEAK | ❌ WEAK | 🟡 PARTIAL |

---

## 5. Current Signal Status (Last 10 Trading Days)

| Signal | 05-22 | 05-26 | 05-27 | 05-28 | 05-29 | 06-01 | 06-02 | 06-03 | 06-04 | 06-05 |
|--------|------|------|------|------|------|------|------|------|------|------|
| `g1_vix_backwardation` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | 🔴 |
| `g1_vix_spike` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | 🔴 |
| `g1_vix_momentum` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | 🔴 |
| `g2_hy_static` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g2_hy_zscore` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g2_ig_static` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g3_stl_fsi` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g3_nfci` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g4_yc_10y2y` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g4_yc_10y3m` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g5_fg_extreme_fear` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g5_fg_fear_zone` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g6_sector_convergent` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g7_rsi_oversold` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g7_price_zscore` | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 | 🔴 |
| `g8_layer_a_bearish` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g9_crisis_composite_red` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g10_volume_surge` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g11_safe_haven` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g11_corr_velocity` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ |
| `g12_composite` | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | ⬛ | 🔴 |

---

## 6. Conclusions

### Build in frontend (validated across 2+ periods):
Signals that show STRONG or USEFUL in both in-sample AND forward test.

### Use with caution (monitor only):
Signals that are SENSITIVE (high recall, low precision) — show as 'elevated risk'.

### Do NOT build (random noise):
Signals that are WEAK in both periods — remove from system or recalibrate threshold.

> **Key insight:** No signal is a 'crash predictor'. These are probability elevation tools.
> Show precision/recall stats in the UI so users know the accuracy before acting.

---
_Report by `backtest/run.py` | Bloomberg Terminal | 2026-06-06_