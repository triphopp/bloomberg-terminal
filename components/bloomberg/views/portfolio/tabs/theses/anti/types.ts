// Shapes of /api/v2/antithesis — see backend/routers/antithesis.py.

export type AAngle = "FACT" | "CAUSE" | "LOGIC" | "TIME" | "PRICE" | "OTHER";
export type AClaimStatus =
  | "FALLEN"
  | "BROKEN"
  | "CONTESTED"
  | "UNTESTED"
  | "STANDS"
  | "REVISED"
  | "RETIRED";
export type AObjStatus = "OPEN" | "PENDING" | "UNDECIDED" | "REBUTTED" | "CONCEDED" | "WITHDRAWN";
export type AAngleState = "open" | "conceded" | "rebutted" | "none_found" | "untried";
export type AResult = "REBUTTED" | "CONCEDED" | "UNDECIDED";
export type ASummary = "EMPTY" | "KEY_FALLEN" | "OPEN" | "STANDING" | "SETTLED";

export interface AZettel {
  id: string;
  ref: string;
  title: string;
  sources: { url: string; publisher: string; quote: string; reliability: string }[];
}

export interface AVerdict {
  id: string;
  result: AResult;
  reasoning: string;
  evidence: AZettel[];
  searched: string;
  next_check: string | null;
  consequence: "REVISE" | "FALLS" | null;
  revised_statement: string;
  revised_negation: string;
  actor: string;
  created_at: string;
  review: { result: "ACCEPTED" | "REJECTED"; note: string; created_at: string } | null;
}

export interface AObjection {
  id: string;
  ref: string;
  claim_id: string;
  parent_id: string | null;
  angle: AAngle;
  argument: string;
  would_see: string;
  look_where: string;
  withdrawn_at: string | null;
  withdraw_reason: string;
  actor: string;
  created_at: string;
  /** Derived on read by the backend — never stored. */
  state: { status: AObjStatus; due: boolean };
  question: { id: string; ref: string; title: string; status: string } | null;
  /** The verdict the user stands behind: their own, or an agent's they accepted. */
  verdict: AVerdict | null;
  /** An agent's newer verdict nobody has reviewed. */
  proposal: AVerdict | null;
  history: AVerdict[];
}

/** "Searched this angle for an objection and found none" — `look_where` is where. */
export interface ASweep {
  id: string;
  angle: AAngle;
  look_where: string;
  actor: string;
  created_at: string;
}

export interface AClaimState {
  status: AClaimStatus;
  /** 1 = the first wording; each revision adds one. */
  round: number;
  /** What is still missing: "negation" | "angles" | "would_see". */
  gaps: string[];
  angles: Record<string, AAngleState>;
  untried: AAngle[];
  /** It stands and every angle was tried — nothing left to argue. */
  settled: boolean;
  objections: Record<string, number>;
  challenged_at: string | null;
}

export interface AClaim {
  id: string;
  ref: string;
  thesis_id: string;
  symbol: string | null;
  statement: string;
  negation: string;
  basis: string;
  stake: "KEY" | "SUPPORT";
  retired_at: string | null;
  retire_reason: string;
  actor: string;
  created_at: string;
  state: AClaimState;
  revises: { id: string; ref: string; statement: string } | null;
  revised_by: { id: string; ref: string; statement: string } | null;
  objections: AObjection[];
  sweeps: ASweep[];
}

export interface ACounts {
  fallen: number;
  broken: number;
  contested: number;
  untested: number;
  stands: number;
  revised: number;
  retired: number;
  pending: number;
  due: number;
  settled: number;
  key_fallen: number;
  key_open: number;
  /** Beliefs still owed an argument. */
  open: number;
  /** What needs the user now: a fallen key claim, a claim to rewrite, a verdict to review. */
  alert: number;
}

export interface ACountsPayload extends ACounts {
  by_thesis: Record<string, ACounts & { verdict: ASummary }>;
}

export interface ABoard {
  claims: AClaim[];
  counts: ACounts;
  summary: { verdict: ASummary; live: number; challenged_at: string | null };
  required_angles: AAngle[];
}

export const A_CLAIM: Record<AClaimStatus, { text: string; color: string }> = {
  FALLEN: { text: "ล้ม", color: "#f87171" },
  BROKEN: { text: "ต้องเขียนใหม่", color: "#f87171" },
  CONTESTED: { text: "ถูกท้าอยู่", color: "#fbbf24" },
  UNTESTED: { text: "ยังไม่เคยถูกท้า", color: "#fb923c" },
  STANDS: { text: "ยืนอยู่", color: "#4ade80" },
  REVISED: { text: "ถูกแทนที่", color: "#777" },
  RETIRED: { text: "เลิกใช้", color: "#777" },
};

export const A_OBJ: Record<AObjStatus, { text: string; color: string }> = {
  OPEN: { text: "ค้าง", color: "#f87171" },
  PENDING: { text: "รอรับรอง", color: "#fbbf24" },
  UNDECIDED: { text: "ยังตัดสินไม่ได้", color: "#fbbf24" },
  REBUTTED: { text: "หักล้างแล้ว", color: "#4ade80" },
  CONCEDED: { text: "ข้อโต้แย้งชนะ", color: "#f87171" },
  WITHDRAWN: { text: "ถอนแล้ว", color: "#777" },
};

export const A_RESULT: Record<AResult, string> = {
  REBUTTED: "หักล้างได้ — ข้อโต้แย้งไม่จริง",
  CONCEDED: "ข้อโต้แย้งชนะ — ข้อที่เชื่อต้องเปลี่ยน",
  UNDECIDED: "ค้นแล้วยังตัดสินไม่ได้",
};

/** The ways a belief can be wrong. `ask` is the question to put to the claim. */
export const A_ANGLE: Record<AAngle, { text: string; ask: string }> = {
  FACT: { text: "ข้อเท็จจริง", ask: "ข้อมูลที่ใช้ผิด เก่า หรือวัดคนละอย่างกับที่อ้างหรือไม่" },
  CAUSE: { text: "สาเหตุอื่น", ask: "สิ่งที่เห็นเกิดจากเหตุอื่นได้ไหม — เหตุที่ไม่พา thesis ไปด้วย" },
  LOGIC: { text: "ตรรกะ", ask: "ข้อมูลถูก แต่ข้อสรุปข้ามขั้นหรือเกินกว่าที่ข้อมูลรองรับหรือไม่" },
  TIME: { text: "เวลา·ขอบเขต", ask: "จริงวันนี้ แต่นานพอ กว้างพอ และทันกรอบเวลาของ thesis หรือไม่" },
  PRICE: { text: "อยู่ในราคา", ask: "จริง แต่ตลาดรู้และจ่ายไปแล้วหรือไม่ ฝั่งตรงข้ามรู้อะไรที่เราไม่รู้" },
  OTHER: { text: "อื่น ๆ", ask: "" },
};

export const A_ANGLE_STATE: Record<AAngleState, { mark: string; text: string; color: string }> = {
  open: { mark: "●", text: "มีข้อโต้แย้งค้าง", color: "#fbbf24" },
  conceded: { mark: "✗", text: "ข้อโต้แย้งชนะ", color: "#f87171" },
  rebutted: { mark: "✓", text: "ท้าแล้ว หักล้างได้", color: "#4ade80" },
  none_found: { mark: "–", text: "ค้นแล้วไม่พบข้อโต้แย้ง", color: "#4ade80" },
  untried: { mark: "○", text: "ยังไม่เคยท้ามุมนี้", color: "#fb923c" },
};

export const A_SUMMARY: Record<ASummary, { text: string; color: string }> = {
  EMPTY: { text: "ยังไม่มีข้อที่เชื่อยืนอยู่บนกระดาน", color: "#888" },
  KEY_FALLEN: { text: "ข้อหลักล้ม — thesis ต้องทบทวน", color: "#f87171" },
  OPEN: { text: "ยังไม่ผ่าน — มีข้อที่ยังไม่ถูกท้าหรือข้อโต้แย้งค้าง", color: "#fbbf24" },
  STANDING: { text: "ทุกข้อยืนอยู่ แต่ยังท้าไม่ครบทุกมุม", color: "#a3e635" },
  SETTLED: { text: "ไม่เหลือข้อโต้แย้ง — ทุกข้อยืน และถูกท้าครบทุกมุม", color: "#4ade80" },
};

export const A_GAP: Record<string, string> = {
  negation: "ด้านกลับ",
  angles: "มุมที่ยังไม่ท้า",
  would_see: "ถ้าจริงจะเห็นอะไร",
};

/** Objections as a thread: each one followed by the objections that continue it. */
export function threaded(objections: AObjection[]): { o: AObjection; depth: number }[] {
  const ids = new Set(objections.map((o) => o.id));
  const out: { o: AObjection; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const o of objections) {
      const p = o.parent_id && ids.has(o.parent_id) ? o.parent_id : null;
      if (p !== parent) continue;
      out.push({ o, depth });
      if (depth < 8) walk(o.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
