# 04 Stress Scenario Analysis

**Status:** NOT STARTED  
**Purpose:** Replay historical crash scenarios on current portfolio positions

## Scenarios Available (in backend/routers/risk.py)

| ID | Event | Period | SPY Return |
|----|-------|--------|-----------|
| covid_2020 | COVID crash | Feb-Mar 2020 | -34% |
| gfc_2008 | Global Financial Crisis | Sep-Nov 2008 | -40% |
| rate_hike_2022 | Fed rate shock | Jan-Oct 2022 | -25% |
| flash_crash_2015 | China/ETF flash crash | Aug 2015 | -12% peak |
| thai_1997 | Asian financial crisis | Jul-Dec 1997 | SET -50% |

## Planned Tests

1. **Scenario replay on current portfolio** -- fetch positions from `portfolio.db`, reprice using historical factor shocks
2. **Correlation stress test** -- apply stressed covariance (vol x1.3, corr pulled 50% toward 1)
3. **Conditional scenario** -- "if SPY -20%, what is expected loss for each position?"
4. **Tail copula simulation** -- t-Copula for joint tail distribution

## How to Run (when implemented)

```bash
cd backtest
python 04_stress_scenarios/run.py --account-id all --scenario covid_2020
```

## Expected Output

```
04_stress_scenarios/results/YYYY-MM-DD/
  scenario_covid_2020.md    -- per-position P&L under scenario
  scenario_gfc_2008.md
  worst_case_portfolio.md   -- combined stress test summary
  report.md                 -- full stress report
```
