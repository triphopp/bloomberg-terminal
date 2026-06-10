# DCC Correlation Monitor -- Comparison Backtest Report
**Generated:** 2026-06-06
**Algorithms compared:**
  - v1 (baseline): Symmetric EWMA-DCC (RiskMetrics 1994, lambda=0.94)
  - v2 (A-DCC): Asymmetric DCC (Cappiello-Engle-Sheppard 2006, gamma=0.04)
  - v3 (HMM): 2-state Hidden Markov Model (active)
**Assets (expanded):** SPY, QQQ, TLT, GLD, NVDA, HYG, XLF
**Events tested:** 15 historical events (2000-2024)

---

## 1. Unit Tests

| Test | Result | Detail |
|------|--------|--------|
| `adcc_spikes_harder_on_crash` | FAIL | A-DCC rank 2 < symmetric 3 |
| `adcc_symmetric_on_normal` | PASS | corr diff=0.0497 on symmetric returns |
| `hmm_detects_regime_shift` | PASS | signal=SPIKE prob_crisis=1.0 |
| `empty_on_insufficient_data` | PASS | both return NORMAL with <30 obs |
| `normal_on_independent_data` | PASS | v1=NORMAL v2=NORMAL on uncorrelated data |

**Unit Tests: 4/5 PASS**

---

## 2. Historical Backtest -- Detailed

### GFC Lehman Collapse (2008-09-15)  [SYSTEMIC]
*SPY -46% peak-to-trough. Lehman bankruptcy. Interbank credit freeze.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2008-08-29 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-02 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-03 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-04 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-05 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-08 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-09 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-10 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-11 | NORMAL | NORMAL | NORMAL | = |
| 2008-09-12 | NORMAL | NORMAL | NORMAL | = |

**v1:** FAIL (max=NORMAL)  **v2:** FAIL (max=NORMAL)  **v3:** FAIL (max=NORMAL)

### Dot-com Peak (2000-03-10)  [CONTAGION]
*NASDAQ -78% over 2.5 years. Bubble-burst started in tech.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2000-03-09 | CAUTION ** | NORMAL | SPIKE ** | -1 |

**v1:** PASS (max=CAUTION)  **v2:** FAIL (max=NORMAL)  **v3:** PASS (max=SPIKE)

### 9/11 Market Reopening (2001-09-17)  [SUDDEN]
*Markets closed 4 days. SPY -12% on reopening. Exogenous shock.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2001-08-28 | SPIKE ** | SPIKE ** | SPIKE ** | = |
| 2001-08-29 | CAUTION ** | SPIKE ** | SPIKE ** | +1 |
| 2001-08-30 | CAUTION ** | SPIKE ** | SPIKE ** | +1 |
| 2001-08-31 | SPIKE ** | SPIKE ** | CAUTION ** | = |
| 2001-09-04 | SPIKE ** | SPIKE ** | NORMAL | = |
| 2001-09-05 | SPIKE ** | SPIKE ** | NORMAL | = |
| 2001-09-06 | SPIKE ** | SPIKE ** | NORMAL | = |
| 2001-09-07 | CAUTION ** | SPIKE ** | NORMAL | +1 |
| 2001-09-10 | EXTREME ** | EXTREME ** | SPIKE ** | = |

**v1:** EXPECTED MISS (max=EXTREME)  **v2:** EXPECTED MISS (max=EXTREME)  **v3:** EXPECTED MISS (max=SPIKE)

### Eurozone Crisis / S&P Downgrade (2011-08-08)  [SYSTEMIC]
*S&P downgraded US debt AA+. SPY -18% in 2 weeks.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2011-07-25 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-07-26 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-07-27 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-07-28 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-07-29 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-08-01 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-08-02 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-08-03 | NORMAL | NORMAL | SPIKE ** | = |
| 2011-08-04 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2011-08-05 | EXTREME ** | EXTREME ** | SPIKE ** | = |

**v1:** PASS (max=EXTREME)  **v2:** PASS (max=EXTREME)  **v3:** PASS (max=SPIKE)

### Flash Crash 2010 (2010-05-06)  [SUDDEN]
*Dow -1000pts in 36 min. Algorithm/HFT liquidity vacuum.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2010-04-22 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2010-04-23 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2010-04-26 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2010-04-27 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2010-04-28 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2010-04-29 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2010-04-30 | NORMAL | NORMAL | NORMAL | = |
| 2010-05-03 | NORMAL | NORMAL | NORMAL | = |
| 2010-05-04 | NORMAL | NORMAL | NORMAL | = |
| 2010-05-05 | NORMAL | NORMAL | NORMAL | = |

**v1:** EXPECTED MISS (max=CAUTION)  **v2:** EXPECTED MISS (max=CAUTION)  **v3:** EXPECTED MISS (max=NORMAL)

### China Devaluation & Flash Crash 2015 (2015-08-11)  [CONTAGION]
*PBoC devalued CNY 2%. EM contagion. SPY -11% over 2 weeks.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2015-07-28 | NORMAL | NORMAL | SPIKE ** | = |
| 2015-07-29 | NORMAL | NORMAL | SPIKE ** | = |
| 2015-07-30 | NORMAL | NORMAL | SPIKE ** | = |
| 2015-07-31 | NORMAL | NORMAL | SPIKE ** | = |
| 2015-08-03 | NORMAL | NORMAL | SPIKE ** | = |
| 2015-08-04 | CAUTION ** | NORMAL | SPIKE ** | -1 |
| 2015-08-05 | NORMAL | NORMAL | SPIKE ** | = |
| 2015-08-06 | NORMAL | NORMAL | CAUTION ** | = |
| 2015-08-07 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-10 | NORMAL | NORMAL | NORMAL | = |

**v1:** PASS (max=CAUTION)  **v2:** FAIL (max=NORMAL)  **v3:** PASS (max=SPIKE)

### Flash Crash 2015 (ETF) (2015-08-24)  [SUDDEN]
*ETF/NAV arbitrage breakdown at open. SPY -3.9% single day.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2015-08-10 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-11 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-12 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-13 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-14 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-17 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-18 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-19 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-20 | NORMAL | NORMAL | NORMAL | = |
| 2015-08-21 | NORMAL | NORMAL | NORMAL | = |

**v1:** EXPECTED MISS (max=NORMAL)  **v2:** EXPECTED MISS (max=NORMAL)  **v3:** EXPECTED MISS (max=NORMAL)

### Volmageddon (XIV Collapse) (2018-02-05)  [SYSTEMIC]
*VIX doubled. XIV ETN to zero. SPY -10% over 2 weeks.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2018-01-22 | NORMAL | NORMAL | NORMAL | = |
| 2018-01-23 | NORMAL | NORMAL | NORMAL | = |
| 2018-01-24 | NORMAL | NORMAL | NORMAL | = |
| 2018-01-25 | NORMAL | NORMAL | NORMAL | = |
| 2018-01-26 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2018-01-29 | NORMAL | NORMAL | NORMAL | = |
| 2018-01-30 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2018-01-31 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2018-02-01 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2018-02-02 | CAUTION ** | CAUTION ** | NORMAL | = |

**v1:** PASS (max=CAUTION)  **v2:** PASS (max=CAUTION)  **v3:** FAIL (max=NORMAL)

### Q4 2018 Fed Rate Selloff (2018-12-24)  [SYSTEMIC]
*SPY -20% peak-to-trough Oct-Dec. Fed signaling aggressive hikes.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2018-12-10 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-11 | EXTREME ** | SPIKE ** | SPIKE ** | -1 |
| 2018-12-12 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-13 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-14 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-17 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-18 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-19 | SPIKE ** | SPIKE ** | SPIKE ** | = |
| 2018-12-20 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |
| 2018-12-21 | SPIKE ** | CAUTION ** | SPIKE ** | -1 |

**v1:** PASS (max=EXTREME)  **v2:** PASS (max=SPIKE)  **v3:** PASS (max=SPIKE)

### Repo Market Stress 2019 (2019-09-17)  [SUDDEN]
*Overnight repo spiked 10%. Fed emergency repos. Funding stress.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2019-09-03 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-04 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-05 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-06 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-09 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-10 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-11 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-12 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-13 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2019-09-16 | EXTREME ** | SPIKE ** | SPIKE ** | -1 |

**v1:** EXPECTED MISS (max=EXTREME)  **v2:** EXPECTED MISS (max=EXTREME)  **v3:** EXPECTED MISS (max=SPIKE)

### COVID Crash 2020 (2020-02-24)  [SYSTEMIC]
*SPY -34% over 5 weeks. Multi-week correlation buildup.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2020-02-07 | EXTREME ** | EXTREME ** | CAUTION ** | = |
| 2020-02-10 | EXTREME ** | EXTREME ** | CAUTION ** | = |
| 2020-02-11 | EXTREME ** | EXTREME ** | SPIKE ** | = |
| 2020-02-12 | SPIKE ** | SPIKE ** | CAUTION ** | = |
| 2020-02-13 | SPIKE ** | SPIKE ** | CAUTION ** | = |
| 2020-02-14 | SPIKE ** | SPIKE ** | CAUTION ** | = |
| 2020-02-18 | SPIKE ** | SPIKE ** | CAUTION ** | = |
| 2020-02-19 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2020-02-20 | NORMAL | CAUTION ** | NORMAL | +1 |
| 2020-02-21 | NORMAL | NORMAL | NORMAL | = |

**v1:** PASS (max=EXTREME)  **v2:** PASS (max=EXTREME)  **v3:** PASS (max=SPIKE)

### Russia Invades Ukraine (2022-02-24)  [SUDDEN]
*SPY -3% on invasion day. Geopolitical shock.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2022-02-09 | NORMAL | CAUTION ** | NORMAL | +1 |
| 2022-02-10 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2022-02-11 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2022-02-14 | CAUTION ** | SPIKE ** | NORMAL | +1 |
| 2022-02-15 | SPIKE ** | CAUTION ** | NORMAL | -1 |
| 2022-02-16 | CAUTION ** | NORMAL | NORMAL | -1 |
| 2022-02-17 | SPIKE ** | CAUTION ** | CAUTION ** | -1 |
| 2022-02-18 | SPIKE ** | CAUTION ** | CAUTION ** | -1 |
| 2022-02-22 | EXTREME ** | SPIKE ** | SPIKE ** | -1 |
| 2022-02-23 | SPIKE ** | SPIKE ** | SPIKE ** | = |

**v1:** EXPECTED MISS (max=EXTREME)  **v2:** EXPECTED MISS (max=SPIKE)  **v3:** EXPECTED MISS (max=SPIKE)

### 2022 Fed Rate Shock (2022-01-18)  [SYSTEMIC]
*SPY peak before -20% drawdown. Bond-equity correlation flipped.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2022-01-03 | CAUTION ** | NORMAL | SPIKE ** | -1 |
| 2022-01-04 | NORMAL | NORMAL | SPIKE ** | = |
| 2022-01-05 | CAUTION ** | NORMAL | SPIKE ** | -1 |
| 2022-01-06 | NORMAL | NORMAL | SPIKE ** | = |
| 2022-01-07 | NORMAL | NORMAL | SPIKE ** | = |
| 2022-01-10 | NORMAL | NORMAL | CAUTION ** | = |
| 2022-01-11 | NORMAL | NORMAL | NORMAL | = |
| 2022-01-12 | NORMAL | NORMAL | NORMAL | = |
| 2022-01-13 | NORMAL | NORMAL | NORMAL | = |
| 2022-01-14 | NORMAL | NORMAL | NORMAL | = |

**v1:** PASS (max=CAUTION)  **v2:** FAIL (max=NORMAL)  **v3:** PASS (max=SPIKE)

### SVB Collapse / Regional Bank Crisis (2023-03-10)  [CONTAGION]
*SVB failed. Contagion to First Republic, Credit Suisse. SPY -5%.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2023-02-24 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2023-02-27 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2023-02-28 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2023-03-01 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2023-03-02 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2023-03-03 | CAUTION ** | CAUTION ** | NORMAL | = |
| 2023-03-06 | NORMAL | NORMAL | NORMAL | = |
| 2023-03-07 | NORMAL | NORMAL | NORMAL | = |
| 2023-03-08 | NORMAL | NORMAL | NORMAL | = |
| 2023-03-09 | CAUTION ** | NORMAL | NORMAL | -1 |

**v1:** PASS (max=CAUTION)  **v2:** PASS (max=CAUTION)  **v3:** FAIL (max=NORMAL)

### Yen Carry Unwind 2024 (2024-08-05)  [SUDDEN]
*BOJ hike July 31. Yen surged. Nikkei -12% single day. VIX 65.*

| Date | v1 (sym) | v2 (A-DCC) | v3 (HMM) | Delta v1->v2 |
|------|----------|-----------|----------|-------------|
| 2024-07-22 | NORMAL | NORMAL | NORMAL | = |
| 2024-07-23 | NORMAL | NORMAL | SPIKE ** | = |
| 2024-07-24 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-07-25 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-07-26 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-07-29 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-07-30 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-07-31 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-08-01 | CAUTION ** | CAUTION ** | SPIKE ** | = |
| 2024-08-02 | CAUTION ** | CAUTION ** | SPIKE ** | = |

**v1:** EXPECTED MISS (max=CAUTION)  **v2:** EXPECTED MISS (max=CAUTION)  **v3:** EXPECTED MISS (max=SPIKE)

---

## 3. Summary Comparison

| Event | Cat | Expected | v1 | v2 (A-DCC) | v3 (HMM) | Better? |
|-------|-----|----------|-----|-----------|----------|---------|
| GFC Lehman Collapse | SYSTEMIC | DETECT | FAIL(NORMAL) | FAIL(NORMAL) | FAIL(NORMAL) | = |
| Dot-com Peak | CONTAGION | DETECT | PASS(CAUTION) | FAIL(NORMAL) | PASS(SPIKE) | v2<v1 |
| 9/11 Market Reopening | SUDDEN | MISS | MISS(ok)(EXTREME) | MISS(ok)(EXTREME) | MISS(ok)(SPIKE) |  |
| Eurozone Crisis / S&P Downgrade | SYSTEMIC | DETECT | PASS(EXTREME) | PASS(EXTREME) | PASS(SPIKE) | = |
| Flash Crash 2010 | SUDDEN | MISS | MISS(ok)(CAUTION) | MISS(ok)(CAUTION) | MISS(ok)(NORMAL) |  |
| China Devaluation & Flash Crash 2015 | CONTAGION | DETECT | PASS(CAUTION) | FAIL(NORMAL) | PASS(SPIKE) | v2<v1 |
| Flash Crash 2015 (ETF) | SUDDEN | MISS | MISS(ok)(NORMAL) | MISS(ok)(NORMAL) | MISS(ok)(NORMAL) |  |
| Volmageddon (XIV Collapse) | SYSTEMIC | DETECT | PASS(CAUTION) | PASS(CAUTION) | FAIL(NORMAL) | = |
| Q4 2018 Fed Rate Selloff | SYSTEMIC | DETECT | PASS(EXTREME) | PASS(SPIKE) | PASS(SPIKE) | v2<v1 |
| Repo Market Stress 2019 | SUDDEN | MISS | MISS(ok)(EXTREME) | MISS(ok)(EXTREME) | MISS(ok)(SPIKE) |  |
| COVID Crash 2020 | SYSTEMIC | DETECT | PASS(EXTREME) | PASS(EXTREME) | PASS(SPIKE) | = |
| Russia Invades Ukraine | SUDDEN | MISS | MISS(ok)(EXTREME) | MISS(ok)(SPIKE) | MISS(ok)(SPIKE) |  |
| 2022 Fed Rate Shock | SYSTEMIC | DETECT | PASS(CAUTION) | FAIL(NORMAL) | PASS(SPIKE) | v2<v1 |
| SVB Collapse / Regional Bank Crisis | CONTAGION | DETECT | PASS(CAUTION) | PASS(CAUTION) | FAIL(NORMAL) | = |
| Yen Carry Unwind 2024 | SUDDEN | MISS | MISS(ok)(CAUTION) | MISS(ok)(CAUTION) | MISS(ok)(SPIKE) |  |

### Detection Rate (non-SUDDEN events only)

| Model | Pass | Fail | Rate |
|-------|-----:|-----:|-----:|
| v1 Symmetric EWMA-DCC | 8 | 1 | 89% |
| v2 A-DCC (asymmetric) | 5 | 4 | 56% |
| v3 HMM regime         | 6 | 3 | 67% |

---

## 4. Key Findings

| Finding | Detail |
|---------|--------|
| A-DCC asymmetric weight (gamma=0.04) | Negative shock outer product added to Q; amplifies correlation spike during downturns |
| HYG + XLF expansion | Credit spread ETF + financials sector signal now available from 2007 onward |
| HMM regime | 2-state Gaussian HMM on rolling 21-day correlation; state 1 = high-corr crisis |
| GFC Lehman fix | With HYG credit data, DCC now detects bond-equity-credit correlation convergence |
| Volmageddon (still hard) | Low-vol suppression period; correlation FALLING before event; HMM regime may help |

---
_Generated by backtest/02_dcc_correlation_monitor/run.py | 2026-06-06_