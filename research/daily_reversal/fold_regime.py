"""Post-mortem: characterize each fold's test-window regime via SPY and
compare with the fold's OOS expectancy. Descriptive only — no new hypothesis
is being tested here, so no kill-list applies."""

import numpy as np
import pandas as pd
import yfinance as yf

# Test-window start dates and expectancies from the one-shot run (stdout record)
FOLDS = [
    ("2018-08-01", +108.7), ("2019-02-01", -30.6), ("2019-08-02", -21.7),
    ("2020-02-03", +2.9),   ("2020-08-03", +7.8),  ("2021-02-02", +83.5),
    ("2021-08-03", +24.6),  ("2022-02-01", -80.6), ("2022-08-03", -34.8),
    ("2023-02-02", +42.2),  ("2023-08-04", -68.9), ("2024-02-05", +31.6),
    ("2024-08-06", -8.0),   ("2025-02-06", -201.1), ("2025-08-08", -122.7),
]
TEST_SESSIONS = 126

spy = yf.download("SPY", period="10y", interval="1d", auto_adjust=True,
                  progress=False, multi_level_index=False)["Close"]

rows = []
for start, exp in FOLDS:
    seg = spy[spy.index >= start].iloc[:TEST_SESSIONS]
    ret = seg.pct_change().dropna()
    total = seg.iloc[-1] / seg.iloc[0] - 1
    vol = ret.std() * np.sqrt(252)
    # Efficiency ratio: |net move| / sum of |daily moves| — 1 = pure trend, →0 = chop
    er = abs(total) / ret.abs().sum()
    peak = seg.cummax()
    mdd = ((seg - peak) / peak).min()
    rows.append({"start": start, "exp_bps": exp, "spy_ret%": 100 * total,
                 "vol%": 100 * vol, "eff_ratio": er, "maxDD%": 100 * mdd})

df = pd.DataFrame(rows)
print(df.to_string(index=False, float_format=lambda x: f"{x:+.2f}"))

for col in ["spy_ret%", "vol%", "eff_ratio", "maxDD%"]:
    r = np.corrcoef(df[col], df["exp_bps"])[0, 1]
    print(f"corr(exp, {col}) = {r:+.2f}")

pos, neg = df[df.exp_bps > 0], df[df.exp_bps <= 0]
print("\nmeans           positive-folds  negative-folds")
for col in ["spy_ret%", "vol%", "eff_ratio", "maxDD%"]:
    print(f"  {col:10s}  {pos[col].mean():+10.2f}  {neg[col].mean():+10.2f}")
