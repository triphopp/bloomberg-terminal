import { Token, AstNode, ArgValue, ParseResult } from "./types";
import { tokenize } from "./lexer";
import { NAV_NAMES, SETTING_NAMES } from "./registry";

export class ParseError extends Error {}

// ── Internal parser ───────────────────────────────────────────────────────────

function parseTokens(tokens: Token[]): AstNode {
  let pos = 0;

  const peek  = (): Token => tokens[pos];
  const atEnd = (): boolean => tokens[pos].kind === "EOF";

  function eat(kind: Token["kind"]): Token {
    const t = tokens[pos];
    if (t.kind !== kind) {
      throw new ParseError(
        `Expected ${kind} but got '${t.raw}' at position ${t.pos}`,
      );
    }
    pos++;
    return t;
  }

  function parseArg(): ArgValue {
    const t = tokens[pos++];
    if (t.kind === "PERIOD") return { type: "period", value: t.raw };
    if (t.kind === "NUMBER") return { type: "number", value: parseFloat(t.raw) };
    if (t.kind === "IDENT")  return { type: "symbol", value: t.raw };
    throw new ParseError(`Unexpected token '${t.raw}' in argument list`);
  }

  function parseFuncCall(name: string): AstNode {
    eat("LPAREN");
    const args: ArgValue[] = [];
    while (!atEnd() && peek().kind !== "RPAREN") {
      // skip leading/trailing commas gracefully
      if (peek().kind === "COMMA") { pos++; continue; }
      args.push(parseArg());
      if (!atEnd() && peek().kind === "COMMA") pos++;
    }
    if (!atEnd()) eat("RPAREN");
    return { kind: "call", fn: name, args };
  }

  // ── Top-level dispatch ────────────────────────────────────────────────────
  if (atEnd()) throw new ParseError("Empty input");

  const first = eat("IDENT");

  // function call: IDENT "("
  if (!atEnd() && peek().kind === "LPAREN") {
    return parseFuncCall(first.raw);
  }

  // collect remaining IDENTs for multi-word commands (ALERT OFF, YTD ON…)
  const parts: string[] = [first.raw];
  while (!atEnd() && peek().kind === "IDENT") {
    parts.push(tokens[pos++].raw);
  }
  const full = parts.join(" ");

  // classify: nav vs setting vs bare lookup
  if (NAV_NAMES.has(full))     return { kind: "nav",    cmd: full };
  if (SETTING_NAMES.has(full)) return { kind: "set",    cmd: full };
  if (parts.length === 1)      return { kind: "lookup", symbol: first.raw };

  // multi-word but not registered — treat as setting (will fail gracefully in executor)
  return { kind: "set", cmd: full };
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parse(raw: string): ParseResult {
  try {
    const tokens = tokenize(raw);
    const ast    = parseTokens(tokens);
    return { ok: true, ast };
  } catch (e) {
    return {
      ok:    false,
      error: e instanceof ParseError ? e.message : "Parse error",
    };
  }
}

/**
 * Returns true when the input looks like it will enter command / function mode
 * (first IDENT matches a registered function, nav or setting command).
 * Used by autocomplete and mode detection without a full parse.
 */
export function isCommandLike(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  if (!upper) return false;
  const first = upper.split(/[\s(]/)[0];
  return (
    NAV_NAMES.has(upper) ||
    SETTING_NAMES.has(upper) ||
    [...SETTING_NAMES].some(n => n.startsWith(upper)) ||
    [...NAV_NAMES].some(n => n.startsWith(upper)) ||
    upper.includes("(")  // function call in progress
  );
}
