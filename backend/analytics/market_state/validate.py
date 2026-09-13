"""
Walk-forward validation — the only place in this package allowed to make a claim
about what a state is followed by.

── Why the dashboard's numbers cannot answer this ───────────────────────────

The dashboard fits one model on the whole history. Its LABELS are causal (a
filtered posterior sees no future), but its PARAMETERS are not: the covariance
that defines "turbulent" was estimated partly from bars that had not happened
yet at the time being labelled. That is fine for answering "what state is this
symbol in now", and useless for answering "what tends to follow this state",
because the second question is exactly where in-sample parameters flatter
themselves.

So this module refits. Walk forward in blocks: fit on everything up to
`block_start − EMBARGO`, label only the block, move on. Every label it produces
is one the model could have produced at the time, and every statistic built on
top is out-of-sample.

── What it reports ──────────────────────────────────────────────────────────

  * forward return after each state, against the symbol's unconditional
    baseline, with a Welch t so a 40-bar state cannot masquerade as a finding;
  * whether the states differ from each other at all (if they do not, the whole
    dashboard is decoration and should be read as such);
  * the strategy edges per state, out-of-sample, which is the actual test of the
    claim that knowing the state helps choose a strategy.

A result that says "no separation" is a successful run, not a failed one. The
repo has been here before: regime_v2 is validated as a risk dial and explicitly
NOT as a volatility forecast, and the BBW squeeze study had to be re-read after
audit. Numbers that do not separate should retire the label, not be stared at.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import hmm, strategy
from .features import build_features

# Bars between the end of a training window and the start of the block it
# labels. Features look back up to 252 bars, so an embargo shorter than that
# leaves the training window overlapping the test block's inputs; 21 is the
# value regime_v2's validated study used and is kept for consistency, with the
# residual overlap stated rather than hidden.
EMBARGO = 21

# Minimum bars before the first fit. Below ~500 a 4-state full-covariance HMM is
# estimating more parameters than the data can support.
MIN_TRAIN = 500

# Bars labelled per refit. Smaller = more honest (the model is refreshed more
# often) and slower. 126 ≈ half a year.
DEFAULT_STEP = 126

# Hard ceiling on refits per request, so a 20-year symbol cannot turn one HTTP
# call into a two-minute fit loop.
MAX_REFITS = 40

HORIZONS = (5, 10, 21)

# A state must own at least this many labelled bars before its forward-return
# statistic is allowed to count as a finding. A rare state on one symbol can
# produce a |t| over 3 from forty bars, and that number is an artefact.
MIN_STATE_BARS = 100


def _overlap_adjust(t: float | None, horizon: int) -> float | None:
    """Deflate a t-statistic for overlapping forward windows.

    Forward returns measured every bar over an h-bar horizon share h−1 bars with
    their neighbours, so consecutive observations are strongly autocorrelated and
    the effective independent sample is closer to n/h than to n. That inflates
    the standard Welch t by about √h. Dividing by √h is the crude, conservative
    correction: it is not a Newey-West estimate, it errs toward finding nothing,
    and that is the right direction for a statistic whose job is to stop the rest
    of this package from being believed too easily.
    """
    if t is None:
        return None
    return float(t / np.sqrt(horizon))


def _welch_t(a: np.ndarray, b: np.ndarray) -> float | None:
    """Welch's t for "these two samples have different means".

    Welch rather than Student: regime samples have wildly different variances by
    construction (that is half of what a regime IS), and the equal-variance
    version would report significance that comes from the variance gap.
    """
    if len(a) < 5 or len(b) < 5:
        return None
    va, vb = a.var(ddof=1), b.var(ddof=1)
    se = np.sqrt(va / len(a) + vb / len(b))
    if not se > 0:
        return None
    return float((a.mean() - b.mean()) / se)


def walk_forward(
    ohlcv: pd.DataFrame,
    n_states: int = hmm.DEFAULT_N_STATES,
    step: int = DEFAULT_STEP,
    seed: int = 42,
) -> dict:
    """Refit-and-label forward through history; return out-of-sample statistics."""
    fs = build_features(ohlcv)
    if fs.bars_out < MIN_TRAIN + step:
        return {
            "status": "insufficient",
            "bars": fs.bars_out,
            "needed": MIN_TRAIN + step,
        }

    values = fs.frame.to_numpy()
    index = fs.frame.index
    n = len(values)

    starts = list(range(MIN_TRAIN + EMBARGO, n, step))
    if len(starts) > MAX_REFITS:
        # Widen the step rather than truncating history: a validation that
        # silently covers only the first third of the sample is worse than one
        # with coarser refits, because the reader cannot see the omission.
        step = int(np.ceil((n - MIN_TRAIN - EMBARGO) / MAX_REFITS))
        starts = list(range(MIN_TRAIN + EMBARGO, n, step))

    oos_key = np.full(n, None, dtype=object)
    refits = 0
    failures = 0

    for start in starts:
        train_end = start - EMBARGO
        if train_end < MIN_TRAIN:
            continue
        try:
            fm = hmm.fit(values[:train_end], fs.used, n_states=n_states, seed=seed)
            stop = min(start + step, n)
            # The posterior must be run from the beginning of the series, not
            # from the block: a filtered posterior is a recursion, and starting
            # it at the block boundary would throw away the state the market was
            # already in — which is most of what the label is.
            post = hmm.filtered_posterior(fm, values[:stop])
            labels = hmm.hard_labels(post)
            for i in range(start, stop):
                oos_key[i] = fm.keys[labels[i]]
            refits += 1
        except Exception:
            failures += 1
            continue

    labelled = np.array([k is not None for k in oos_key])
    if labelled.sum() < 100:
        return {"status": "insufficient", "bars": int(labelled.sum()), "refits": refits}

    close = ohlcv["close"].reindex(index).astype(float)
    log_px = np.log(close.where(close > 0))

    keys_present = sorted({k for k in oos_key if k is not None},
                          key=lambda k: [a.key for a in hmm.ARCHETYPES].index(k))

    by_state: list[dict] = []
    separation: dict[int, float] = {}

    for horizon in HORIZONS:
        fwd = (log_px.shift(-horizon) - log_px).to_numpy()
        ok = labelled & np.isfinite(fwd)
        pooled = fwd[ok]
        if len(pooled) < 50:
            continue
        spread = []
        for key in keys_present:
            m = ok & np.array([k == key for k in oos_key])
            sample = fwd[m]
            others = fwd[ok & ~m]
            if len(sample) == 0:
                continue
            raw_t = _welch_t(sample, others)
            # A state too thin to count is still reported — hiding it would make
            # the table look more complete than the data is — but it does not
            # feed the spread or the verdict.
            if len(sample) >= MIN_STATE_BARS:
                spread.append(float(sample.mean()))
            by_state.append(
                {
                    "state": key,
                    "label": hmm.ARCHETYPE_BY_KEY[key].label,
                    "horizon": horizon,
                    "n": int(len(sample)),
                    # Reported in % of price, arithmetic, so it lines up with
                    # what the price chart shows.
                    "mean_pct": round(float(np.expm1(sample.mean()) * 100), 3),
                    "median_pct": round(float(np.expm1(np.median(sample)) * 100), 3),
                    "hit_rate": round(float((sample > 0).mean()), 3),
                    "vol_pct": round(float(np.expm1(sample.std(ddof=1)) * 100), 3)
                    if len(sample) > 1
                    else None,
                    "baseline_pct": round(float(np.expm1(pooled.mean()) * 100), 3),
                    "t_vs_rest": (lambda t: round(t, 2) if t is not None else None)(raw_t),
                    "t_adj": (lambda t: round(t, 2) if t is not None else None)(
                        _overlap_adjust(raw_t, horizon)
                    ),
                    "counts": bool(len(sample) >= MIN_STATE_BARS),
                }
            )
        if len(spread) > 1:
            separation[horizon] = round(float(np.expm1(max(spread)) - np.expm1(min(spread))) * 100, 3)

    # ── Does knowing the state change which strategy looks best? ──
    strategy_by_state = []
    key_to_state = {k: i for i, k in enumerate(keys_present)}
    label_ints = [key_to_state.get(k, -1) for k in oos_key]
    for key in keys_present:
        comp = strategy.compatibility(ohlcv, index, label_ints, key_to_state[key])
        best = max(
            (i for i in comp["items"] if i["score"] is not None),
            key=lambda i: i["score"],
            default=None,
        )
        strategy_by_state.append(
            {
                "state": key,
                "label": hmm.ARCHETYPE_BY_KEY[key].label,
                "bars": comp["state_bars"],
                "best": best["name"] if best else None,
                "best_score": best["score"] if best else None,
                "best_z": best["z"] if best else None,
                "items": [
                    {"id": i["id"], "score": i["score"], "z": i["z"], "n": i["n"]}
                    for i in comp["items"]
                ],
            }
        )

    distinct_best = {
        s["best"] for s in strategy_by_state if s["best"] and s["bars"] >= MIN_STATE_BARS
    }
    # Strategy edges are measured on non-overlapping-ish binary outcomes but the
    # forward windows still overlap, so the same √h deflation applies before a z
    # is allowed to mean anything.
    any_significant = any(
        (
            s["best_z"] is not None
            and s["bars"] >= MIN_STATE_BARS
            and abs(s["best_z"] / np.sqrt(strategy.HORIZON)) >= 2
        )
        for s in strategy_by_state
    )

    return {
        "status": "ok",
        "method": {
            "refits": refits,
            "failed_fits": failures,
            "step": int(step),
            "embargo": EMBARGO,
            "min_train": MIN_TRAIN,
            "labelled_bars": int(labelled.sum()),
            "total_bars": int(n),
            "n_states": n_states,
            "min_state_bars": MIN_STATE_BARS,
            "overlap_note": (
                "Forward windows overlap, so the raw Welch t is inflated by roughly √horizon. "
                "`t_adj` divides it out; the verdict uses `t_adj` and ignores states with fewer "
                f"than {MIN_STATE_BARS} labelled bars."
            ),
            "note": (
                "Each block is labelled by a model fitted only on bars ending "
                f"{EMBARGO} sessions before it. Features look back up to 252 bars, so a "
                "residual input overlap remains inside that embargo — the labels are "
                "out-of-sample, not perfectly purged."
            ),
        },
        "forward_returns": by_state,
        "separation_pct": separation,
        "strategy_by_state": strategy_by_state,
        "verdict": _verdict(by_state, distinct_best, any_significant),
    }


def _verdict(by_state: list[dict], distinct_best: set, any_significant: bool) -> dict:
    """A plain reading of whether any of this survived contact with the data."""
    # The OVERLAP-ADJUSTED t decides, and only for states with enough bars. The
    # raw t is still shown in the table, because a reader comparing the two
    # learns more about the statistic than any footnote could tell them.
    strong = [
        r
        for r in by_state
        if r.get("counts") and r.get("t_adj") is not None and abs(r["t_adj"]) >= 2
    ]
    return {
        "states_separate": bool(strong),
        "separating_states": [
            {
                "state": r["state"],
                "horizon": r["horizon"],
                "t_adj": r["t_adj"],
                "t_raw": r["t_vs_rest"],
                "n": r["n"],
            }
            for r in strong
        ],
        "strategy_choice_varies": len(distinct_best) > 1,
        "strategy_edge_significant": bool(any_significant),
        "reading": _reading(bool(strong), len(distinct_best) > 1, any_significant),
    }


def _reading(separates: bool, varies: bool, significant: bool) -> str:
    if not separates and not varies:
        return (
            "No out-of-sample separation: forward returns after each state are within noise of "
            "the symbol's baseline, and the same strategy looks best in every state. Read the "
            "dashboard as a description of what the market is doing, not as an edge."
        )
    if separates and not significant:
        return (
            "Forward returns differ by state out-of-sample, but no strategy edge reaches |z| ≥ 2. "
            "The state is informative about the environment; it is not yet evidence for a rule."
        )
    if not separates and varies:
        return (
            "Forward returns do not separate, yet the best-scoring strategy differs by state. "
            "Treat that as a hypothesis about which style suits which environment, not a result."
        )
    return (
        "States separate on forward return AND at least one strategy edge reaches |z| ≥ 2 "
        "out-of-sample. Still a single symbol with no costs modelled — the next step is the "
        "research harness, not a position."
    )
