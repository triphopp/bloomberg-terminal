"""
Equity Allocation Confluence Signal — analytics package.

Three independent layers measuring different dimensions of equity allocation:
  Layer A — Market Sentiment (SPY/AGG relative performance z-score)
  Layer B — Flow Direction    (ETF flow proxy via price-adjusted AUM)
  Layer C — Structural Position (FRED Z.1 household equity share)

References:
  [1] Asness, Ilmanen, Israel & Moskowitz (2015) — Investing with Style
  [2] Moskowitz, Ooi & Pedersen (2012) — Time Series Momentum
  [3] Ben-David, Franzoni & Moussawi (2018) — Do ETFs Increase Volatility?
  [4] Moreira & Muir (2017) — Volatility-Managed Portfolios
"""
from .layer_a import compute_layer_a
from .layer_b import compute_layer_b
from .layer_c import compute_layer_c
from .confluence import compute_confluence
from .country_rotation import compute_momentum, compute_macro_quality, compute_carry, compute_rotation_scores, COUNTRY_UNIVERSE
