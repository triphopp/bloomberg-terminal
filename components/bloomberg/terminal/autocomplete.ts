import { tokenize } from "./lexer";
import { ALL_COMMANDS, CMD_MAP } from "./registry";

/**
 * Precomputed set of all first-words from command names + aliases.
 * Used for exact-first-word mode detection.
 * e.g. "ALERT OFF" → "ALERT", "CORR" → "CORR", alias "COR" → "COR"
 */
const CMD_FIRST_WORDS: Set<string> = new Set(
  ALL_COMMANDS.flatMap((c) => [
    c.name.split(" ")[0],
    ...(c.aliases ?? []).map((a) => a.split(" ")[0]),
  ]),
);

export interface Suggestion {
  /** Full text to replace input with on Tab/click */
  completion: string;
  /** Short label shown in list */
  label:      string;
  /** Description text */
  desc:       string;
  /** Visual group tag */
  group:      string;
  /** Whether this is a function (show arg hints) */
  isFunc:     boolean;
}

const GROUP_SORT: Record<string, number> = {
  analysis: 0,
  nav:      1,
  setting:  2,
  info:     3,
};

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "5y", "5d", "10d"];

/**
 * Context-aware autocomplete for the terminal input.
 *
 * Cases handled:
 *   ""           → [] (empty, don't show)
 *   "cor"        → ["CORR(A, B, period?)"]
 *   "corr("      → hint for arg 1
 *   "corr(AAPL," → hint for arg 2 + period suggestions
 *   "al"         → ["ALERT ON", "ALERT OFF", "ALERT CLEAR"]
 *   "mkt"        → ["MKT"]
 */
export function getSuggestions(raw: string): Suggestion[] {
  const upper = raw.trim().toUpperCase();
  if (!upper) return [];

  const tokens = tokenize(raw);
  const hasOpen = tokens.some((t) => t.kind === "LPAREN");

  // ── Inside function call — show arg hints ─────────────────────────────────
  if (hasOpen) {
    const fnName = tokens[0]?.raw;
    const def    = CMD_MAP.get(fnName);
    if (!def || !def.args) return [];

    const commaCount = tokens.filter((t) => t.kind === "COMMA").length;
    const argIdx     = commaCount;
    const argDef     = def.args[argIdx];
    if (!argDef) return [];

    if (argDef.type === "period") {
      return PERIODS.map((p) => ({
        completion: `${raw.trim().replace(/,?\s*$/, "")}, ${p})`,
        label:      p,
        desc:       "period",
        group:      "period",
        isFunc:     false,
      }));
    }

    // symbol arg hint
    return [{
      completion: raw,
      label:      `<${argDef.name.toUpperCase()}>`,
      desc:       argDef.optional ? "optional symbol" : "required symbol (e.g. AAPL, ^GSPC)",
      group:      "hint",
      isFunc:     false,
    }];
  }

  // ── Top-level: match by prefix ────────────────────────────────────────────
  const matches = ALL_COMMANDS.filter(
    (c) =>
      c.name.startsWith(upper) ||
      (c.aliases ?? []).some((a) => a.startsWith(upper)),
  );

  return matches
    .map((c) => {
      const isFunc  = c.group === "analysis";
      const argHint = isFunc && c.args
        ? `(${c.args.map((a) => (a.optional ? `${a.name}?` : a.name)).join(", ")})`
        : "";
      return {
        completion: isFunc ? `${c.name}(` : c.name,
        label:      c.name + argHint,
        desc:       c.description,
        group:      c.group,
        isFunc,
      };
    })
    .sort((a, b) => (GROUP_SORT[a.group] ?? 9) - (GROUP_SORT[b.group] ?? 9));
}

/**
 * True when the input should trigger command/function mode.
 *
 * Rule: EXACT first-word match against registered command names/aliases.
 * Prefix match is intentionally NOT used here — "CO" stays in stock-search
 * mode; "CORR" (exact) enters command mode. This prevents false triggers
 * like "A" → ALERT or "FX" accidentally hijacking stock-ticker searches.
 *
 * Exceptions:
 *   - Input contains "(" → function call in progress → always command mode
 */
export function isCommandInput(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  if (!upper) return false;
  if (upper.includes("(")) return true;

  const first = upper.split(/\s+/)[0];
  return CMD_FIRST_WORDS.has(first);
}
