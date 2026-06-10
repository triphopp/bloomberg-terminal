import { Token } from "./types";

/** Matches period literals like 3m, 1y, 5d, 2w */
const PERIOD_RE = /^(\d+)(d|w|m|y)$/i;

/**
 * Tokenize raw terminal input.
 * Case-normalised to uppercase for identifiers.
 * Always appends an EOF token.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const s = input.trim();
  let i   = 0;

  while (i < s.length) {
    // skip whitespace
    if (/\s/.test(s[i])) { i++; continue; }

    // single-char punctuation
    if (s[i] === "(") { tokens.push({ kind: "LPAREN", raw: "(", pos: i++ }); continue; }
    if (s[i] === ")") { tokens.push({ kind: "RPAREN", raw: ")", pos: i++ }); continue; }
    if (s[i] === ",") { tokens.push({ kind: "COMMA",  raw: ",", pos: i++ }); continue; }

    // number (digits, optional decimal) — check for period suffix e.g. "3m" "1y"
    if (/[0-9]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      // period suffix directly after digits?
      if (j < s.length && /[dwmy]/i.test(s[j])) {
        j++;  // consume suffix
        tokens.push({ kind: "PERIOD", raw: s.slice(i, j).toLowerCase(), pos: i });
      } else {
        tokens.push({ kind: "NUMBER", raw: s.slice(i, j), pos: i });
      }
      i = j;
      continue;
    }

    // identifier: letters, digits, ^ . = - _ (covers ^GSPC, BTC-USD, GC=F)
    if (/[A-Za-z^]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9^.\-_=]/.test(s[j])) j++;
      const raw = s.slice(i, j);
      if (PERIOD_RE.test(raw)) {
        tokens.push({ kind: "PERIOD", raw: raw.toLowerCase(), pos: i });
      } else {
        tokens.push({ kind: "IDENT", raw: raw.toUpperCase(), pos: i });
      }
      i = j;
      continue;
    }

    // unknown character — skip silently
    i++;
  }

  tokens.push({ kind: "EOF", raw: "", pos: s.length });
  return tokens;
}
