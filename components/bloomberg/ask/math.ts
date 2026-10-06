/**
 * Finding LaTeX in an ASK answer. Pure — the drawing (KaTeX) is in ask-answer.tsx.
 *
 * Inline: `$…$` or `\(…\)`. Display: `$$…$$` or `\[…\]`, on one line or as a
 * block of its own lines. The model is told to use `$` / `$$` (`_SYSTEM` in
 * backend/routers/news_ai.py); the bracket forms are what other models send.
 */

export type MathSpan =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean };

// A single `$` also means dollars. `$…$` is math only when it opens and closes
// tight against its content, is not followed by a digit, and holds something a
// price never does (\ _ ^ = {) — so "$5 to $10" and "$1,200-$1,300" stay text.
// The one exception is a lone letter, `$K$`: a variable named in a sentence.
const MATH_RE =
  /\$\$([^$]+?)\$\$|\\\[(.+?)\\\]|\\\((.+?)\\\)|\$(?!\s)([^$\n]*?[\\_^={][^$\n]*?)(?<!\s)\$(?!\d)|(?<![A-Za-z\d])\$([A-Za-z])\$(?![A-Za-z\d])/g;

/** Running text cut into plain stretches and formulas, in order. */
export function splitMath(text: string): MathSpan[] {
  const out: MathSpan[] = [];
  let last = 0;
  for (const m of text.matchAll(MATH_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    const display = m[1] ?? m[2];
    out.push({
      kind: "math",
      tex: (display ?? m[3] ?? m[4] ?? m[5]).trim(),
      display: display !== undefined,
    });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const FENCES: [open: string, close: string][] = [
  ["$$", "$$"],
  ["\\[", "\\]"],
];

/**
 * A display formula standing on its own lines, starting at `lines[start]`:
 * the fence may share a line with the formula or sit alone above and below it.
 * Returns the TeX and the index of the last line it used — or null when the
 * line is not one, or the closing fence has not arrived yet (still streaming),
 * in which case the caller shows the text as it is.
 */
export function displayMathAt(lines: string[], start: number): { tex: string; end: number } | null {
  const first = lines[start];
  const fence = FENCES.find(([open]) => first.startsWith(open));
  if (!fence) return null;
  const [open, close] = fence;

  const parts: string[] = [];
  for (let i = start; i < lines.length; i++) {
    let line = lines[i];
    if (i === start) line = line.slice(open.length);
    // Only a fence that ends the line closes the block; text after it means
    // this was an inline formula opening a sentence.
    if (line.endsWith(close) && (i > start || first.length >= open.length + close.length)) {
      parts.push(line.slice(0, -close.length));
      const tex = parts.join("\n").trim();
      return tex && !tex.includes(close) ? { tex, end: i } : null;
    }
    parts.push(line);
  }
  return null;
}
