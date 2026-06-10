# 03 VaR Model Validation

**Status:** NOT STARTED  
**Purpose:** Kupiec POF + DQ tests on historical VaR breach rates

## What to Test

| Test | Method | Pass Criterion |
|------|--------|---------------|
| Kupiec POF | Count exceptions vs expected at 95% confidence | p-value > 0.05 |
| Basel Traffic Light | Exception rate vs 1-confidence | Green = ok, Red = model broken |
| DQ (Dynamic Quantile) | Conditional coverage -- exceptions should not cluster | p > 0.05 |
| Cornish-Fisher vs Historical | CF VaR should be tighter in fat-tail regimes | CF/Hist ratio 1.1-1.4 |
| MC vs Historical | MC CVaR should match historical in stressed periods | MC/Hist ratio 1.0-1.3 |

## Data Requirements

- Portfolio positions history (from `portfolio.db`)
- Daily returns per position (yfinance)
- At least 252 trading days of history per account

## How to Run (when implemented)

```bash
cd backtest
python 03_var_model_validation/run.py --account-id all --lookback 252
```

## Expected Output

```
03_var_model_validation/results/YYYY-MM-DD/
  kupiec_results.csv       -- POF test results per account/period
  dq_results.csv           -- DQ test results
  exception_calendar.md    -- heatmap of breach dates
  report.md                -- full validation report
```
