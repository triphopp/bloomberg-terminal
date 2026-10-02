// Shapes of /api/v2/questions — see backend/routers/questions.py.

export type QStatus = "OPEN" | "WATCH" | "CLEAR" | "DROPPED";
export type QLevel = "CONFIRMED" | "INFERRED" | "UNCLEAR" | "UNANSWERABLE";

/** Derived on read by the backend — never stored, so it cannot drift between devices. */
export interface QState {
  status: QStatus;
  reason: string;
  level: QLevel | null;
  basis: string | null;
  answer: string;
  current_answer_id: string | null;
  proposed_answer_id: string | null;
  assumptions: { held: number; broken: number; untested: number };
  due: boolean;
}

export interface Question {
  id: string;
  ref: string;
  thesis_id: string | null;
  symbol: string | null;
  title: string;
  thought: string;
  is_root: boolean;
  priority: number | null;
  next_check: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  dropped_at: string | null;
  drop_reason: string;
  actor: string;
  created_at: string;
  /** What is still missing to place it in the tree: "parent" | "effect" | "thought". */
  gaps: string[];
}

/** A row of the list / tree: the question plus its state and how many
 *  questions above it are still waiting on it. */
export interface QNode extends Question {
  state: QState;
  blocks: number;
}

export interface QEdge {
  id: string;
  child_id: string;
  parent_id: string;
  if_a: string;
  if_b: string;
}

export interface QCounts {
  pending: number;
  watch: number;
  clear: number;
  dropped: number;
  due: number;
}

export interface QCountsPayload extends QCounts {
  by_thesis: Record<string, QCounts>;
}

export interface QTree {
  nodes: QNode[];
  edges: QEdge[];
  counts: QCounts;
  leaves: { total: number; clear: number };
}

export interface ZettelBrief {
  id: string;
  ref: string;
  title: string;
  sources: {
    url: string;
    publisher: string;
    published_at: string | null;
    reliability: string;
  }[];
}

export interface QCheck {
  id: string;
  result: string;
  note: string;
  actor: string;
  created_at: string;
}

export interface QSignal {
  id: string;
  expectation: string;
  result: "FOUND" | "NOT_FOUND" | "NOT_SEARCHED" | "CONTRARY";
  finding: string;
  supports: string;
  diagnostic: boolean;
  origin: string;
  searched_where: string;
  zettel: ZettelBrief | null;
}

export interface QAssumption {
  id: string;
  statement: string;
  metric: string;
  source_hint: string;
  check_by: string | null;
  falsifier: string;
  check: QCheck | null;
  check_zettel: ZettelBrief | null;
}

export interface QAnswer {
  id: string;
  level: QLevel;
  basis: string | null;
  answer: string;
  value: string | null;
  unit: string | null;
  as_of: string | null;
  alternatives: string[];
  searched: string;
  next_check: string | null;
  actor: string;
  created_at: string;
  evidence: ZettelBrief[];
  signals: QSignal[];
  assumptions: QAssumption[];
  review: QCheck | null;
}

export interface QLink {
  id: string;
  ref: string;
  title: string;
  if_a: string;
  if_b: string;
  edge_id?: string;
}

export interface QDetail {
  question: Question;
  state: QState;
  parents: QLink[];
  children: QLink[];
  answers: QAnswer[];
  /** Calendar dates this question is waiting on. */
  dates: {
    id: string;
    ref: string;
    title: string;
    date: string;
    status: "CONFIRMED" | "ESTIMATED";
    source: string;
    source_url: string;
    link_id: string;
    reads: string;
  }[];
}

/** One calendar row — GET /api/v2/questions/calendar. */
export interface QDate {
  id: string;
  ref: string;
  title: string;
  date: string;
  status: "CONFIRMED" | "ESTIMATED";
  source: string;
  source_url: string;
  symbol: string | null;
  kind: string;
  note: string;
  days_until: number;
  due: boolean;
  questions: {
    link_id: string;
    reads: string;
    id: string;
    ref: string;
    title: string;
    thesis_id: string | null;
    symbol: string | null;
    status: QStatus;
    due: boolean;
  }[];
  changes: {
    id: string;
    old_date: string;
    new_date: string;
    old_status: string;
    new_status: string;
    reason: string;
    created_at: string;
  }[];
}

export interface QCalendar {
  dates: QDate[];
  due: number;
  estimated: number;
}

export const STATUS_COLOR: Record<QStatus, string> = {
  OPEN: "#f87171",
  WATCH: "#fbbf24",
  CLEAR: "#4ade80",
  DROPPED: "#555",
};

/** What the chip says. An OPEN question says WHY it is open — "waiting for you"
 *  and "nobody has looked" call for different next moves. */
export function stateLabel(s: QState): string {
  if (s.status === "DROPPED") return "เลิกติดตาม";
  if (s.reason === "awaiting_review") return "รอรับรอง";
  if (s.reason === "unanswered") return "ค้าง";
  if (s.reason === "unclear") return "ยังไม่ชัด";
  if (s.reason === "assumption_broken") return "สมมติฐานพัง";
  if (s.reason === "unanswerable") return "ตอบไม่ได้";
  if (s.reason === "assumptions_untested") return "อนุมาน";
  return "ชัดเจน";
}

export const LEVEL_LABEL: Record<QLevel, string> = {
  CONFIRMED: "ยืนยันแล้ว",
  INFERRED: "อนุมาน",
  UNCLEAR: "ยังไม่ชัด",
  UNANSWERABLE: "ตอบไม่ได้ด้วยข้อมูลสาธารณะ",
};

export const BASIS_LABEL: Record<string, string> = {
  NUMBER: "ตัวเลขยืนยัน",
  CIRCUMSTANTIAL: "สิ่งแวดล้อมยืนยัน",
  EVENT: "เหตุการณ์ยืนยัน",
};

export const SIGNAL_LABEL: Record<QSignal["result"], { text: string; color: string }> = {
  FOUND: { text: "พบ", color: "#4ade80" },
  NOT_FOUND: { text: "ไม่พบ", color: "#fbbf24" },
  CONTRARY: { text: "ขัด", color: "#f87171" },
  NOT_SEARCHED: { text: "ยังไม่ค้น", color: "#666" },
};

export const actorTag = (actor: string) =>
  actor === "user" ? "" : actor.replace(/^agent:/, "AGENT·").toUpperCase();

export const GAP_LABEL: Record<string, string> = {
  parent: "คำถามแม่",
  effect: "ผลต่อแม่",
  thought: "ความคิดที่นำมา",
};
