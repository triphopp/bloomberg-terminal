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

/** ── Zettelkasten ──────────────────────────────────────────────────────────
 *  A zettel is one idea, written so it stands on its own, and reusable across
 *  theses — unlike a ThesisNote, which belongs to the thesis it was written on.
 *  What makes the archive worth keeping is the edges: a finding that clashes
 *  with an older one is linked to it, not written over it. */
export interface Zettel {
  id: string;
  ref: string;
  kind: ZettelKind;
  title: string;
  body: string;
  stance?: ZettelStance | null;
  confidence?: number | null;
  status: ZettelStatus;
  tags: string;
  /** "user", or "agent:<name>" when the MCP server wrote it. */
  actor: string;
  /** Date of the FACT (filing, article), not of the jotting. */
  occurred_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  /** List view only. */
  source_count?: number;
  open_conflicts?: number;
  snippet?: string;
}

export type ZettelKind =
  | "CLAIM"
  | "EVIDENCE"
  | "QUESTION"
  | "MECHANISM"
  | "DEFINITION"
  | "SOURCE_NOTE";
export type ZettelStatus = "open" | "settled" | "superseded" | "retracted";
export type ZettelStance = "bull" | "bear" | "neutral";
export type ZettelRel =
  | "SUPPORTS"
  | "CONTRADICTS"
  | "REFINES"
  | "SUPERSEDES"
  | "FOLLOWS_FROM"
  | "CONTEXT";

export interface ZettelEdge {
  id: string;
  src_id: string;
  dst_id: string;
  rel: ZettelRel;
  note: string;
  /** Null on a CONTRADICTS edge means the disagreement is still open. */
  resolved_at?: string | null;
  resolution: string;
  actor: string;
  created_at: string;
  /** Joined from the note at the other end. */
  other_ref?: string;
  other_title?: string;
  other_kind?: ZettelKind;
  other_status?: ZettelStatus;
}

export interface ZettelSource {
  id: string;
  zettel_id: string;
  url: string;
  publisher: string;
  title: string;
  published_at?: string | null;
  quote: string;
  reliability: "primary" | "secondary" | "rumor";
}

export interface ZettelRef {
  zettel_id: string;
  target_type: "thesis" | "trade" | "symbol";
  target_id: string;
  role: string;
  symbol?: string;
  thesis_title?: string;
}

export interface ZettelDetail {
  zettel: Zettel;
  sources: ZettelSource[];
  edges: { out: ZettelEdge[]; in: ZettelEdge[] };
  refs: ZettelRef[];
}

/** Both sides of a contradiction, flattened for the conflict panel. */
export interface ZettelConflict extends ZettelEdge {
  src_ref: string;
  src_title: string;
  src_kind: ZettelKind;
  src_stance?: ZettelStance | null;
  src_status: ZettelStatus;
  src_occurred_at?: string | null;
  src_actor: string;
  dst_ref: string;
  dst_title: string;
  dst_kind: ZettelKind;
  dst_stance?: ZettelStance | null;
  dst_status: ZettelStatus;
  dst_occurred_at?: string | null;
  dst_actor: string;
}

export const ZETTEL_KINDS: ZettelKind[] = [
  "CLAIM",
  "EVIDENCE",
  "QUESTION",
  "MECHANISM",
  "DEFINITION",
  "SOURCE_NOTE",
];

export const ZETTEL_RELS: ZettelRel[] = [
  "SUPPORTS",
  "CONTRADICTS",
  "REFINES",
  "SUPERSEDES",
  "FOLLOWS_FROM",
  "CONTEXT",
];

export const ZETTEL_KIND_COLOR: Record<ZettelKind, string> = {
  CLAIM: "#60a5fa",
  EVIDENCE: "#14b8a6",
  QUESTION: "#a78bfa",
  MECHANISM: "#ff9900",
  DEFINITION: "#888",
  SOURCE_NOTE: "#666",
};

export const ZETTEL_STATUS_COLOR: Record<ZettelStatus, string> = {
  open: "#ff9900",
  settled: "#4ade80",
  superseded: "#666",
  retracted: "#f87171",
};

export const ZETTEL_REL_COLOR: Record<ZettelRel, string> = {
  SUPPORTS: "#4ade80",
  CONTRADICTS: "#f87171",
  REFINES: "#60a5fa",
  SUPERSEDES: "#a78bfa",
  FOLLOWS_FROM: "#888",
  CONTEXT: "#666",
};

export const STANCE_COLOR: Record<ZettelStance, string> = {
  bull: "#4ade80",
  bear: "#f87171",
  neutral: "#888",
};
