export interface Thesis {
  id: string;
  symbol: string;
  resolved_symbol?: string | null;
  market?: string | null;
  account_id?: string | null;
  sub_portfolio?: string | null;
  title: string;
  category?: string | null;
  strategy?: string | null;
  status: ThesisStatus;
  conviction?: number | null;
  time_horizon?: string | null;
  target_price?: number | null;
  stop_price?: number | null;
  currency?: string | null;
  body?: string | null;
  source_file?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  event_count?: number;
  /** Notes still open or being watched — the rail badge. */
  open_note_count?: number;
}

export type ThesisStatus = "draft" | "active" | "watch" | "invalidated" | "closed";

export interface ThesisEvent {
  id: string;
  thesis_id: string;
  event_type: string;
  payload?: Record<string, { from: unknown; to: unknown }> | Record<string, unknown> | null;
  note?: string;
  occurred_at: string;
  device_id?: string | null;
  created_at: string;
}

/** A standing note on a thesis — the scenarios, risks and catalysts the user is
 *  tracking. Unlike a ThesisEvent (immutable history) a note is edited in place
 *  until it resolves. */
export interface ThesisNote {
  id: string;
  thesis_id: string;
  kind: NoteKind;
  title: string;
  body: string;
  impact?: NoteImpact | null;
  likelihood?: number | null;
  severity?: number | null;
  status: NoteStatus;
  watch_date?: string | null;
  pinned: number;
  sort_order?: number;
  deleted_at?: string | null;
  device_id?: string | null;
  created_at: string;
  updated_at: string;
  /** Only present on the cross-thesis /notes/due feed. */
  symbol?: string;
  thesis_title?: string;
}

export type NoteKind = "NOTE" | "SCENARIO" | "RISK" | "CATALYST" | "QUESTION" | "EVIDENCE";
export type NoteStatus = "open" | "watching" | "confirmed" | "dismissed";
export type NoteImpact = "bull" | "bear" | "mixed";

export const NOTE_KINDS: NoteKind[] = [
  "SCENARIO",
  "RISK",
  "CATALYST",
  "QUESTION",
  "EVIDENCE",
  "NOTE",
];

export const NOTE_STATUSES: NoteStatus[] = ["open", "watching", "confirmed", "dismissed"];

export const NOTE_KIND_COLOR: Record<NoteKind, string> = {
  SCENARIO: "#60a5fa",
  RISK: "#f87171",
  CATALYST: "#4ade80",
  QUESTION: "#a78bfa",
  EVIDENCE: "#14b8a6",
  NOTE: "#888",
};

export const NOTE_STATUS_COLOR: Record<NoteStatus, string> = {
  open: "#ff9900",
  watching: "#60a5fa",
  confirmed: "#4ade80",
  dismissed: "#666",
};

export const NOTE_IMPACT_COLOR: Record<NoteImpact, string> = {
  bull: "#4ade80",
  bear: "#f87171",
  mixed: "#ff9900",
};

export interface ThesisLink {
  trade_id: string;
  role?: string;
  symbol?: string;
  date_entry?: string;
  date_exit?: string | null;
  price_entry?: number;
  price_exit?: number | null;
  volume?: number;
  win_loss?: string;
  account_id?: string;
}

export const STATUSES: ThesisStatus[] = ["draft", "active", "watch", "invalidated", "closed"];

export const STATUS_COLOR: Record<ThesisStatus, string> = {
  draft: "#888",
  active: "#4ade80",
  watch: "#ff9900",
  invalidated: "#f87171",
  closed: "#666",
};

// Same taxonomy language as the PORT sub-portfolio tags, so a thesis and the
// position it justifies sort under the same heading.
export const CATEGORIES = ["CORE", "GROWTH", "SPECULATIVE", "INCOME", "HEDGE", "WATCHLIST"];

export const HORIZONS = ["3M", "6M", "1Y", "3Y+"];

export const STRATEGIES = ["value", "growth", "event", "turnaround", "macro", "quality"];
