// ─────────────────────────────────────────────────────────────────────────────
// Terminal command language — shared types
// ─────────────────────────────────────────────────────────────────────────────

// ── Lexer ─────────────────────────────────────────────────────────────────────

export type TokenKind =
  | "IDENT"    // CORR  AAPL  MKT  ^GSPC
  | "LPAREN"   // (
  | "RPAREN"   // )
  | "COMMA"    // ,
  | "PERIOD"   // 3m  1y  5d  (digit + d/w/m/y)
  | "NUMBER"   // 0.95  14
  | "EOF";

export interface Token {
  kind: TokenKind;
  raw:  string;
  pos:  number;
}

// ── AST ──────────────────────────────────────────────────────────────────────

export type AstNode =
  /** corr(AAPL, MSFT, 3m) */
  | { kind: "call";   fn: string;  args: ArgValue[] }
  /** MKT  NEWS  PORT  — single-word nav */
  | { kind: "nav";    cmd: string }
  /** ALERT OFF  YTD ON  — multi-word setting */
  | { kind: "set";    cmd: string }
  /** bare AAPL typed without parens → stock search */
  | { kind: "lookup"; symbol: string };

export type ArgValue =
  | { type: "symbol"; value: string }   // AAPL  ^GSPC
  | { type: "period"; value: string }   // 3m  1y
  | { type: "number"; value: number };  // 14  0.05

// ── Registry ─────────────────────────────────────────────────────────────────

export type ArgType = "symbol" | "period" | "number";

export interface ArgDef {
  name:     string;
  type:     ArgType;
  optional: boolean;
  default?: string | number;
}

export type CommandGroup = "nav" | "setting" | "analysis" | "info";

export interface CommandDef {
  /** Canonical full name in UPPERCASE e.g. "CORR" or "ALERT OFF" */
  name:        string;
  aliases?:    string[];
  args?:       ArgDef[];
  description: string;
  group:       CommandGroup;
  handler:     CommandHandler;
}

export interface ResolvedArgs {
  positional: ArgValue[];
}

export interface TerminalCtx {
  setView:          (v: string) => void;
  setTickerEnabled: (b: boolean) => void;
  setDarkMode:      (b: boolean) => void;
  setShowYTD:       (b: boolean) => void;
  setStockSymbol:   (s: string) => void;
  invalidate:       (keys: string[]) => void;
  close:            () => void;
}

export type CommandHandler = (
  args:   ResolvedArgs,
  ctx:    TerminalCtx,
  signal: AbortSignal,
) => CommandResult | Promise<CommandResult>;

// ── Results ───────────────────────────────────────────────────────────────────

export type CommandResult =
  | { kind: "navigate"; view: string }
  | { kind: "action" }
  | { kind: "display"; content: ResultContent }
  | { kind: "error";   message: string }
  | { kind: "stay" };   // keep overlay open (HELP / REGIME)

export type ResultContent =
  | { type: "scalar"; label: string; value: string; sub?: string }
  | { type: "table";  label: string; cols: string[]; rows: RowData[] }
  | { type: "info";   label: string; lines: string[] };

export interface RowData {
  cells:  string[];
  /** optional per-cell color hints: "pos" | "neg" | "accent" | "" */
  colors: string[];
}

// ── Parse / validate result ───────────────────────────────────────────────────

export type ParseResult =
  | { ok: true;  ast: AstNode }
  | { ok: false; error: string };
