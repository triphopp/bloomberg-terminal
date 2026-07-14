"""Populate daily USD/THB FX history used by portfolio reporting.

Run from ``backend/``:
    python scripts/backfill_fx_rates.py --period 10y
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import init_portfolio_v2
from portfolio_currency import backfill_fx_rates


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--period", default="10y", help="Provider period, e.g. 1y, 5y, 10y, max")
    args = parser.parse_args()
    init_portfolio_v2()
    changed = backfill_fx_rates(period=args.period)
    print(f"FX history upserted: {changed} direct/inverse rows")


if __name__ == "__main__":
    main()

