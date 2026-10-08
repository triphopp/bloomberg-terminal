/** GET /api/calendar — backend/calendar_feed.py. */

export type CalCategory = "MACRO" | "COMPANY" | "THESIS" | "PORT";

export interface CalThesis {
  id: string;
  symbol: string;
  title: string;
  status: string;
  /** How the event reached this thesis: its own note, a question or tracked
   *  number of it, or only the same symbol. Absent on the pick list. */
  via?: "note" | "question" | "metric" | "symbol";
}

export interface CalQuestion {
  id: string;
  ref: string;
  title: string;
  thesis_id: string | null;
  status: string;
  /** What will be read from this event for that question. */
  reads: string;
}

export type CalRef =
  | { type: "note"; id: string; thesis_id: string; status: string; impact: string | null }
  | { type: "question_date"; id: string; ref: string; questions: CalQuestion[] }
  | { type: "metric"; id: string; ref: string; thesis_id: string | null };

export interface CalEvent {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  category: CalCategory;
  /** FOMC · CPI · … | EARNINGS · DIVIDEND · SPLIT | NOTE · QDATE · TRACK | EXPIRY · REVIEW */
  kind: string;
  title: string;
  symbol: string | null;
  impact: "high" | "medium" | "low" | null;
  /** The date is a window, a rule or an inference — nobody announced this day. */
  estimated: boolean;
  source: string;
  source_url: string;
  detail: string;
  /** Already happened / resolved — kept on its day, shown dim. */
  done: boolean;
  /** Its day has come and something of a thesis still waits to be read. */
  due: boolean;
  theses: CalThesis[];
  ref: CalRef | null;
  /** Sub-kind: a note's kind (CATALYST…), a question date's kind (FILING…). */
  tag: string | null;
  days_until: number;
}

export interface CalSources {
  macro?: { ok: boolean; releases_ok?: boolean; fomc_through?: string; fomc_missing?: boolean };
  company?: {
    ok: boolean;
    symbols: number;
    loaded: number;
    pending: string[];
    failed: Record<string, Record<string, string>>;
    oldest_pull: string | null;
  };
  notes?: { ok: boolean; count?: number; error?: string };
  dates?: { ok: boolean; count?: number; error?: string };
  port?: { ok: boolean; count?: number; error?: string };
}

export interface CalPayload {
  as_of: string;
  start: string;
  end: string;
  events: CalEvent[];
  sources: CalSources;
  theses: CalThesis[];
}
