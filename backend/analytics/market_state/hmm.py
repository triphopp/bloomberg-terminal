"""
Gaussian HMM over the market-state features, with honest (causal) labelling.

── The lookahead trap this module exists to avoid ───────────────────────────

`model.predict(X)` over a whole sample runs Viterbi with the benefit of every
future bar. Painting that on a chart produces a beautiful regime history that
the model could never have produced at the time, and any statistic computed on
top of it is contaminated. `backend/analytics/regime_v2.py` solves this by
re-running `predict_proba` on a trailing prefix for each bar it labels, which is
correct but costs O(n · context) forward-backward passes.

What that prefix trick actually computes is the FILTERED posterior
P(state_t | x_1..x_t): forward-backward over a prefix ending at t has β_t = 1 at
the last step, so the smoothed posterior of the final row IS the filtered one.
The filtered posterior is available in a single forward pass, so this module
runs the recursion directly — same number, whole history, one pass. Emission
densities come from `means_` / `covars_` and the recursion from `startprob_` /
`transmat_`, all public attributes, so nothing here reaches into hmmlearn's
internals. `tests/test_market_state.py` asserts the two agree bar for bar.

── State identity ───────────────────────────────────────────────────────────

An HMM's state indices are arbitrary and change between fits. Names are assigned
by matching each fitted state's mean vector against archetypes in (trend, vol)
space, with a Hungarian assignment so two states can never claim one name. If a
symbol's history contains no bear-shaped state, no state is called BEAR — the
names describe what was fitted rather than a taxonomy imposed on it.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Fitting more states than the data can support produces regimes that flicker.
# regime_v2's validated market model uses four; this defaults to the same.
DEFAULT_N_STATES = 4

# Consecutive bars a new state must hold before the DISPLAYED label switches.
# Applies only to the hard label; the posterior is never smoothed, because
# smoothing a probability destroys the uncertainty it exists to show.
HYSTERESIS = 3

# ── Archetypes ───────────────────────────────────────────────────────────────
#
# Target points in (trend, vol) standardised space. `trend` is the mean of the
# state's direction features, `vol` its volatility feature. The weights say what
# each name is really ABOUT: TURBULENT is a claim about volatility and says
# nothing about direction, so its trend target carries no weight at all.

@dataclass(frozen=True)
class Archetype:
    key: str
    label: str
    trend: float
    vol: float
    w_trend: float
    w_vol: float
    color: str
    blurb: str


ARCHETYPES: list[Archetype] = [
    Archetype("bull", "BULL TREND", 1.0, 0.0, 1.0, 0.2, "#00FF88",
              "Price trending up with the trend line fitting cleanly"),
    Archetype("sideway", "SIDEWAY", 0.0, 0.0, 1.0, 0.3, "#FFD700",
              "No net direction — range-bound, the home of mean reversion"),
    Archetype("quiet", "QUIET RANGE", 0.0, -1.1, 0.6, 1.0, "#5c9ead",
              "Directionless AND unusually calm — the state expansions start from"),
    Archetype("bear", "BEAR TREND", -1.0, 0.3, 1.0, 0.2, "#FF9800",
              "Price trending down with the trend line fitting cleanly"),
    Archetype("turbulent", "TURBULENT", 0.0, 1.4, 0.0, 1.0, "#FF4444",
              "Volatility far above normal — direction is not the story here"),
]

ARCHETYPE_BY_KEY = {a.key: a for a in ARCHETYPES}

# Features that make up the "trend" coordinate of a state's mean vector.
_TREND_FEATURES = ("ret_z", "slope_z")
_VOL_FEATURE = "rvol_z"


@dataclass
class FittedModel:
    model: object                 # hmmlearn GaussianHMM
    features: list[str]
    mu: np.ndarray                # standardisation mean
    sd: np.ndarray                # standardisation std
    order: list[int]              # canonical position → raw hmmlearn state index
    keys: list[str]               # canonical position → archetype key
    labels: list[str]             # canonical position → display label
    colors: list[str]
    n_states: int


def standardize(values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mu = values.mean(axis=0)
    sd = values.std(axis=0)
    sd = np.where(sd > 0, sd, 1.0)
    return (values - mu) / sd, mu, sd


def fit(values: np.ndarray, features: list[str], n_states: int = DEFAULT_N_STATES,
        seed: int = 42) -> FittedModel:
    """Fit a full-covariance Gaussian HMM and give its states names.

    `random_state` is pinned: EM finds a local optimum and an unpinned seed would
    mean the same symbol showed different regimes on two consecutive page loads.
    """
    from hmmlearn.hmm import GaussianHMM

    X, mu, sd = standardize(values)
    model = GaussianHMM(
        n_components=n_states,
        covariance_type="full",
        n_iter=500,
        tol=1e-4,
        random_state=seed,
    )
    model.fit(X)

    order, keys = _assign_names(model, features, n_states)
    return FittedModel(
        model=model,
        features=features,
        mu=mu,
        sd=sd,
        order=order,
        keys=keys,
        labels=[ARCHETYPE_BY_KEY[k].label for k in keys],
        colors=[ARCHETYPE_BY_KEY[k].color for k in keys],
        n_states=n_states,
    )


def _assign_names(model, features: list[str], n_states: int) -> tuple[list[int], list[str]]:
    """Match fitted states to archetypes, one name each, then order canonically.

    Hungarian rather than greedy: greedy assignment depends on which state is
    considered first, so a tie between two similar states could flip the whole
    naming between fits.
    """
    from scipy.optimize import linear_sum_assignment

    idx = {f: i for i, f in enumerate(features)}
    trend_cols = [idx[f] for f in _TREND_FEATURES if f in idx]
    vol_col = idx.get(_VOL_FEATURE)

    means = model.means_
    # Mean vectors are in standardised units, but an HMM state's mean is a mean
    # of a subset, so its spread is narrower than the full sample's. Rescaling
    # by the spread OF THE STATE MEANS puts them on the same footing as the
    # archetype targets, which are written in "how extreme among states" terms.
    trend = means[:, trend_cols].mean(axis=1) if trend_cols else np.zeros(n_states)
    vol = means[:, vol_col] if vol_col is not None else np.zeros(n_states)
    trend = _rescale(trend)
    vol = _rescale(vol)

    cost = np.zeros((n_states, len(ARCHETYPES)))
    for s in range(n_states):
        for a, arch in enumerate(ARCHETYPES):
            cost[s, a] = (
                arch.w_trend * (trend[s] - arch.trend) ** 2
                + arch.w_vol * (vol[s] - arch.vol) ** 2
            )
    rows, cols = linear_sum_assignment(cost)

    chosen = {int(r): ARCHETYPES[int(c)].key for r, c in zip(rows, cols)}
    canonical = [a.key for a in ARCHETYPES]          # bull → sideway → quiet → bear → turbulent
    ordered = sorted(chosen.items(), key=lambda kv: canonical.index(kv[1]))
    return [s for s, _ in ordered], [k for _, k in ordered]


def _rescale(v: np.ndarray) -> np.ndarray:
    """Centre on the mean of the state means and scale to unit spread."""
    spread = v.std()
    if spread <= 0:
        return np.zeros_like(v)
    return (v - v.mean()) / spread


# ── Causal posterior ─────────────────────────────────────────────────────────

def _log_emission(fm: FittedModel, X: np.ndarray) -> np.ndarray:
    """log N(x_t ; μ_k, Σ_k) for every bar and raw state. Shape (T, K)."""
    means = fm.model.means_
    covars = fm.model.covars_
    T, D = X.shape
    out = np.empty((T, fm.n_states))
    for k in range(fm.n_states):
        cov = covars[k]
        # A state that collapses onto very few observations can produce a
        # near-singular covariance; a small ridge keeps the Cholesky solvable
        # instead of letting one degenerate state blow up the whole posterior.
        try:
            chol = np.linalg.cholesky(cov)
        except np.linalg.LinAlgError:
            chol = np.linalg.cholesky(cov + np.eye(D) * 1e-6)
        diff = X - means[k]
        sol = np.linalg.solve(chol, diff.T)
        maha = (sol**2).sum(axis=0)
        log_det = 2.0 * np.log(np.diag(chol)).sum()
        out[:, k] = -0.5 * (maha + log_det + D * np.log(2 * np.pi))
    return out


def filtered_posterior(fm: FittedModel, values: np.ndarray) -> np.ndarray:
    """P(state_t | x_1..x_t) for every bar, in CANONICAL state order.

    One scaled forward pass. Causal by construction: the recursion at t has seen
    nothing after t, which is the whole point — see the module docstring.
    """
    X = (values - fm.mu) / fm.sd
    log_b = _log_emission(fm, X)
    T = len(X)
    K = fm.n_states
    alpha = np.zeros((T, K))

    log_start = np.log(np.maximum(fm.model.startprob_, 1e-300))
    trans = fm.model.transmat_

    # Work in a scaled (normalised) forward recursion rather than logs: each row
    # is normalised to sum to 1, which is exactly the filtered posterior and
    # keeps the arithmetic in a range where nothing underflows.
    first = log_start + log_b[0]
    first -= first.max()
    a = np.exp(first)
    alpha[0] = a / a.sum()

    for t in range(1, T):
        pred = alpha[t - 1] @ trans
        lb = log_b[t] - log_b[t].max()
        a = pred * np.exp(lb)
        total = a.sum()
        if total <= 0 or not np.isfinite(total):
            # Every state assigns this bar essentially zero density (a gap, a
            # split artefact). Carry the prediction forward rather than emitting
            # NaN and poisoning everything after it.
            alpha[t] = pred / pred.sum()
            continue
        alpha[t] = a / total

    return alpha[:, fm.order]


def hard_labels(posterior: np.ndarray, hysteresis: int = HYSTERESIS) -> list[int]:
    """argmax of the posterior, with hysteresis so the headline stops flickering.

    A one-bar excursion into another state is usually the posterior being
    briefly undecided rather than a regime change, and a label that flips back
    and forth is unreadable. The posterior itself is left alone.
    """
    raw = posterior.argmax(axis=1).tolist()
    if not raw:
        return []
    out: list[int] = []
    current, candidate, streak = raw[0], None, 0
    for s in raw:
        if s == current:
            candidate, streak = None, 0
        elif s == candidate:
            streak += 1
            if streak >= hysteresis:
                current, candidate, streak = s, None, 0
        else:
            candidate, streak = s, 1
        out.append(current)
    return out


def expected_durations(fm: FittedModel) -> list[float]:
    """Mean bars in each state from the transition matrix: 1/(1−p_ii).

    Reported because it is the honest way to read a regime call: a state whose
    self-transition implies a two-day life is a different object from one that
    implies forty, even when both are showing 80% right now.
    """
    trans = fm.model.transmat_
    out = []
    for s in fm.order:
        p = float(trans[s, s])
        out.append(float(1.0 / (1.0 - p)) if p < 1 - 1e-9 else float("inf"))
    return out


def transition_matrix(fm: FittedModel) -> list[list[float]]:
    """Transition matrix reordered into canonical state order."""
    trans = fm.model.transmat_
    return [[round(float(trans[i, j]), 4) for j in fm.order] for i in fm.order]
