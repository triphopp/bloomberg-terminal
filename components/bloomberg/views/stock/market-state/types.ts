/**
 * Payload shapes for the Market State panel.
 *
 * Mirrors `backend/analytics/market_state/__init__.py::get_market_state` and
 * `validate.walk_forward`. Everything optional is optional because the backend
 * genuinely omits it — a symbol with too little history returns `status` and
 * `detail` and nothing else, and a component that assumes otherwise crashes the
 * panel instead of explaining the problem.
 */

export interface StateSlice {
  key: string;
  label: string;
  color: string;
  blurb: string;
  probability: number;
  expected_duration: number | null;
  /** Share of history spent in this state. */
  share: number;
}

export interface ScoreBlock {
  trend?: {
    score: number | null;
    change: number | null;
    word: string | null;
    direction: string | null;
  };
  momentum?: {
    score: number | null;
    change: number | null;
    sign: string | null;
    word: string | null;
  };
  volatility?: {
    sigma: number | null;
    change: number | null;
    level: string | null;
    direction: string | null;
  };
}

export interface StrategyItem {
  id: string;
  name: string;
  metric: string;
  value: number | null;
  baseline: number;
  detail: string;
  rho1?: number | null;
  score: number | null;
  edge: number | null;
  n: number;
  z: number | null;
  reliable: boolean;
}

export interface MarketStateResponse {
  symbol: string;
  status: "ok" | "insufficient" | "error";
  detail?: string;
  as_of?: string;
  bars?: number;
  period?: string;
  basis?: { labels: string; parameters: string; claim: string };
  regime?: {
    key: string;
    label: string;
    color: string;
    probability: number;
    confidence: "clear" | "leaning" | "unclear";
    bars_in_state: number;
    expected_duration: number | null;
    states: StateSlice[];
    transition_note: string | null;
  };
  scores?: ScoreBlock;
  summary?: string;
  vector?: {
    regime_probability: Record<string, number>;
    trend: number | null;
    momentum: number | null;
    volatility: number | null;
  };
  history?: {
    times: string[];
    close: (number | null)[];
    state: number[];
    posterior: number[][];
    trend: (number | null)[];
    momentum: (number | null)[];
    volatility: (number | null)[];
    trend_change: (number | null)[];
    momentum_change: (number | null)[];
    volatility_change: (number | null)[];
  };
  strategy?: {
    horizon: number;
    state_bars: number;
    state: string;
    state_label: string;
    basis: string;
    items: StrategyItem[];
  };
  diagnostics?: {
    redundancy: RedundancyReport;
    model: {
      family: string;
      n_states: number;
      covariance: string;
      features: string[];
      dropped_features: string[];
      bars_in: number;
      bars_used: number;
      hysteresis: number;
      state_labels: string[];
      expected_durations: (number | null)[];
      transition_matrix: number[][];
    };
  };
}

export interface RedundancyReport {
  status: "ok" | "insufficient";
  bars: number;
  threshold?: number;
  model_features?: string[];
  dropped_features?: string[];
  feature_doc?: Record<string, string>;
  rejected_doc?: Record<string, string>;
  matrix?: { names: string[]; values: number[][] };
  model_matrix?: { names: string[]; values: number[][] };
  redundant_pairs?: { a: string; b: string; r: number; both_in_model: boolean }[];
  rejected_vs_model?: {
    feature: string;
    closest_model_feature: string;
    r: number;
    verdict: string;
    reason: string;
  }[];
  vif?: Record<string, number | null>;
  max_model_abs_corr?: number;
}

export interface ValidationResponse {
  symbol?: string;
  status: "ok" | "insufficient" | "error";
  detail?: string;
  bars?: number;
  method?: {
    refits: number;
    failed_fits: number;
    step: number;
    embargo: number;
    min_train: number;
    labelled_bars: number;
    total_bars: number;
    n_states: number;
    min_state_bars: number;
    overlap_note: string;
    note: string;
  };
  forward_returns?: {
    state: string;
    label: string;
    horizon: number;
    n: number;
    mean_pct: number;
    median_pct: number;
    hit_rate: number;
    vol_pct: number | null;
    baseline_pct: number;
    t_vs_rest: number | null;
    t_adj: number | null;
    counts: boolean;
  }[];
  separation_pct?: Record<string, number>;
  strategy_by_state?: {
    state: string;
    label: string;
    bars: number;
    best: string | null;
    best_score: number | null;
    best_z: number | null;
    items: { id: string; score: number | null; z: number | null; n: number }[];
  }[];
  verdict?: {
    states_separate: boolean;
    separating_states: {
      state: string;
      horizon: number;
      t_adj: number;
      t_raw: number;
      n: number;
    }[];
    strategy_choice_varies: boolean;
    strategy_edge_significant: boolean;
    reading: string;
  };
}
