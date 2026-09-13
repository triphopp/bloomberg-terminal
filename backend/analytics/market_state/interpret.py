"""
Market State Vector → one sentence a human can act on.

This module is the "market interpretation" half of the system and knows nothing
about trading. It says what the market is doing; `strategy.py` is the only place
allowed to suggest what that is good for. Keeping them apart is the point of the
whole design: an interpretation that already contains a recommendation cannot be
disagreed with separately from it.

Two rules shape the sentence:

  * Drop what is not saying anything. A neutral trend, flat momentum and stable
    volatility contribute nothing, and a sentence that always has four clauses
    trains the reader to stop reading it.
  * Never hide the uncertainty. When the top regime probability is weak the
    sentence says the regime is unclear instead of naming one confidently — a
    41% call and a 94% call must not read alike.
"""
from __future__ import annotations

# Below this the leading regime is not a call worth printing as a fact.
UNCLEAR_BELOW = 0.50
# Above this the model is not meaningfully hedging between states.
CONFIDENT_ABOVE = 0.75


def regime_confidence_word(p: float) -> str:
    if p >= CONFIDENT_ABOVE:
        return "clear"
    if p >= UNCLEAR_BELOW:
        return "leaning"
    return "unclear"


def build_summary(regime_label: str, regime_p: float, scores: dict) -> str:
    """The headline sentence, e.g.
    "Bull Trend — Positive Momentum but Weakening — Volatility Expanding"."""
    parts: list[str] = []

    label = regime_label.title()
    if regime_p < UNCLEAR_BELOW:
        # Two states within a few points of each other is a real and useful
        # reading — "between regimes" — and pretending otherwise is the one
        # failure mode a probabilistic model is supposed to prevent.
        parts.append(f"Regime unclear (closest: {label} {regime_p:.0%})")
    else:
        parts.append(f"{label} {regime_p:.0%}")

    trend = scores.get("trend") or {}
    t_word, t_dir = trend.get("word"), trend.get("direction")
    if t_word and t_word != "Neutral":
        parts.append(f"{t_word} Trend" + (f" {t_dir}" if t_dir and t_dir != "Flat" else ""))

    mom = scores.get("momentum") or {}
    m_sign, m_word = mom.get("sign"), mom.get("word")
    if m_sign and m_word:
        if m_sign == "Flat":
            if m_word != "Stable":
                parts.append(f"Momentum {m_word}")
        elif m_word == "Stable":
            parts.append(f"{m_sign} Momentum")
        else:
            # "but" carries the tension that makes this reading worth having:
            # positive AND weakening is the case a single number cannot state.
            joiner = "but" if (m_sign == "Positive") == (m_word == "Weakening") else "and"
            parts.append(f"{m_sign} Momentum {joiner} {m_word}")

    vol = scores.get("volatility") or {}
    v_level, v_dir = vol.get("level"), vol.get("direction")
    if v_level and v_dir:
        if v_dir == "Stable":
            if v_level != "Normal":
                parts.append(f"{v_level} Volatility")
        else:
            prefix = "" if v_level == "Normal" else f"{v_level} "
            parts.append(f"{prefix}Volatility {v_dir}")

    return " — ".join(parts)


def transition_note(posterior_tail, labels: list[str], lookback: int = 10) -> str | None:
    """One line about where the regime is MOVING, or None if it is not.

    The brief's point about derivatives applies to the posterior too: a state
    sitting at 55% on its way up from 20% is a different situation from the same
    55% on its way down, and neither the label nor the probability shows it.
    """
    if posterior_tail is None or len(posterior_tail) <= lookback:
        return None
    now = posterior_tail[-1]
    then = posterior_tail[-1 - lookback]
    deltas = [(now[i] - then[i], i) for i in range(len(labels))]
    gain, gi = max(deltas)
    loss, li = min(deltas)
    if gain < 0.20 or gi == li:
        return None
    return (
        f"{labels[gi].title()} gaining ({then[gi]:.0%} → {now[gi]:.0%} over {lookback} bars)"
        f", {labels[li].title()} giving way ({then[li]:.0%} → {now[li]:.0%})"
    )
