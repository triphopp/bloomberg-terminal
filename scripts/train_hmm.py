"""
Train 4-state Gaussian HMM — thin CLI wrapper around regime_calibration.

The backend auto-trains on startup when model is missing or older than 30 days.
Run this script manually only to force a retrain or run validation.

Usage:
    python scripts/train_hmm.py              # train only
    python scripts/train_hmm.py --validate   # train + walk-forward validation
    python scripts/train_hmm.py --validate-only  # validation without retraining

Requires: hmmlearn>=0.3.0, yfinance>=0.2.40

References:
    Hamilton (1989) Econometrica 57(2):357-384
    Ang & Bekaert (2002) Review of Financial Studies 15(4):1137-1187
    Guidolin & Timmermann (2007) JEDC 31(12):3982-4013
"""
from __future__ import annotations

import sys
import os

# Allow running from repo root or scripts/ directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from analytics.regime_calibration import train_mrs_model, walk_forward_validate


def _print_stability(stability: dict) -> None:
    print("\n  Threshold stability (std < 0.02 = stable, > 0.05 = drift):")
    for key, v in stability.items():
        flag = "OK" if v["std"] < 0.02 else ("WARN" if v["std"] < 0.05 else "BAD")
        print(f"    {key:<25}  mean={v['mean']:.4f}  std={v['std']:.4f}  [{flag}]")


def _print_spot_checks(spot_checks: list, hit_rate: float | None) -> None:
    print("\n  Spot-checks on known regime periods:")
    for s in spot_checks:
        if "correct" not in s:
            print(f"    {s['period']:<25}  {s.get('status', 'skip')}")
        else:
            mark = "✓" if s["correct"] else "✗"
            print(f"    {mark} {s['period']:<24}  expected={s['expected']:<10}  "
                  f"actual={s['actual']:<10}  avg_score={s['avg_score']:.4f}  n={s['n_obs']}")
    if hit_rate is not None:
        grade = "GOOD" if hit_rate >= 0.80 else ("MARGINAL" if hit_rate >= 0.60 else "POOR")
        print(f"\n  Hit rate: {hit_rate:.0%}  [{grade}]")


def main() -> None:
    args = set(sys.argv[1:])
    do_train    = "--validate-only" not in args
    do_validate = "--validate" in args or "--validate-only" in args

    if do_train:
        print("Training 4-state Gaussian HMM on rolling CORR score history...")
        try:
            result = train_mrs_model(triggered_by="cli")
            print(f"\nDone.")
            print(f"  Observations : {result['n_obs']}")
            print(f"  State means  : {result['state_means']}")
            print(f"  Thresholds   : {result['thresholds']}")
            print(f"  Trained at   : {result['trained_at']}")
        except Exception as e:
            print(f"Training failed: {e}", file=sys.stderr)
            sys.exit(1)

    if do_validate:
        print("\nRunning walk-forward validation (8 expanding folds, ~5-10 min)...")
        try:
            result = walk_forward_validate()
            print(f"  Folds completed: {result['n_folds']}")
            _print_stability(result["threshold_stability"])
            _print_spot_checks(result["spot_checks"], result["hit_rate"])
            print(f"\n  Full results saved to data/models/validation.json")
        except Exception as e:
            print(f"Validation failed: {e}", file=sys.stderr)
            sys.exit(1)

    if do_train and not do_validate:
        print("\nRestart the backend server to pick up new thresholds.")
        print("Run with --validate to also check threshold stability.")


if __name__ == "__main__":
    main()
