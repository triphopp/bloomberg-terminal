"use client";

import katex from "katex";
import { Fragment, type ReactNode } from "react";
import "katex/dist/katex.min.css";
import { displayMathAt, splitMath } from "./math";
import type { ThemeColors } from "./types";

/**
 * An ASK answer laid out for reading, not dumped as one block of text.
 *
 * The model is asked for a small, fixed shape (see `_SYSTEM` in
 * backend/routers/news_ai.py): a lead, then `## ` section titles, `- ` bullets
 * with the source in brackets at the end, `**` around the figure that matters.
 * This file turns that shape into blocks: the lead stands apart, each section
 * gets a rule and a title, each bullet hangs from its marker, and the source
 * drops to its own dim line so the fact and where it came from never run together.
 *
 * Anything that does not fit the shape still renders — as a plain paragraph.
 * LaTeX (`$…$`, `$$…$$`, see math.ts) is typeset with KaTeX wherever it appears.
 */

export type AnswerBlock =
  | { kind: "lead"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "bullet"; text: string; source: string | null; marker: string | null }
  | { kind: "para"; text: string }
  /** A formula on its own lines (`$$…$$`). */
  | { kind: "math"; tex: string };

const BULLET_RE = /^[-*•▪·]\s+(.*)$/;
const NUMBERED_RE = /^(\d{1,2})[.)]\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const BOLD_LINE_RE = /^\*\*([^*]+)\*\*\s*:?$/;
const TRAILING_PAREN_RE = /^(.*\S)\s*\(([^()]{2,160})\)[\s.]*$/;

const MONTH_RE =
  /\d{4}|\d{1,2}\s?(?:ม\.ค|ก\.พ|มี\.ค|เม\.ย|พ\.ค|มิ\.ย|ก\.ค|ส\.ค|ก\.ย|ต\.ค|พ\.ย|ธ\.ค|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i;

/** A closing bracket is a source when it names an outlet or a date, not when it explains. */
function looksLikeSource(inner: string): boolean {
  return (
    /https?:\/\//.test(inner) ||
    MONTH_RE.test(inner) ||
    /^[A-Za-z][\w .&/'-]{1,40}$/.test(inner) ||
    /(?:^|[\s,])(?:as of|ณ|ที่มา|source|อ้างอิง)/i.test(inner)
  );
}

function splitSource(text: string): { body: string; source: string | null } {
  const m = TRAILING_PAREN_RE.exec(text);
  if (m && looksLikeSource(m[2]))
    return { body: m[1].replace(/[\s—–-]+$/, ""), source: m[2].trim() };
  return { body: text, source: null };
}

function stripBold(text: string): string {
  return text.replace(/\*\*/g, "").replace(/:\s*$/, "");
}

export function parseAnswer(text: string): AnswerBlock[] {
  const lines = text.split("\n").map((l) => l.trim());
  const blocks: AnswerBlock[] = [];
  const isBullet = (l: string | undefined) => !!l && (BULLET_RE.test(l) || NUMBERED_RE.test(l));
  const nextFilled = (from: number) => lines.slice(from).find((l) => l.length > 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const formula = displayMathAt(lines, i);
    if (formula) {
      blocks.push({ kind: "math", tex: formula.tex });
      i = formula.end;
      continue;
    }

    const heading = HEADING_RE.exec(line) ?? BOLD_LINE_RE.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: stripBold(heading[1]) });
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const numbered = NUMBERED_RE.exec(line);
    if (bullet || numbered) {
      const { body, source } = splitSource(bullet ? bullet[1] : (numbered?.[2] ?? ""));
      blocks.push({ kind: "bullet", text: body, source, marker: numbered ? numbered[1] : null });
      continue;
    }
    // A short unmarked line sitting right above a list is that list's title.
    if (line.length <= 70 && !/[.。!?]$/.test(line) && isBullet(nextFilled(i + 1))) {
      blocks.push({ kind: "heading", text: stripBold(line) });
      continue;
    }
    // Wrapped text: a line directly under a paragraph continues it.
    const prev = blocks[blocks.length - 1];
    if (prev && (prev.kind === "para" || prev.kind === "lead") && lines[i - 1]) {
      prev.text += ` ${line}`;
      continue;
    }
    blocks.push({ kind: blocks.length === 0 ? "lead" : "para", text: line });
  }
  return blocks;
}

// ── Math ─────────────────────────────────────────────────────────────────────

// An answer is drawn again on every batch of streamed tokens; a formula that
// has not changed is not typeset again.
const texCache = new Map<string, string>();

function texHtml(tex: string, display: boolean): string {
  const key = `${display ? "D" : "I"}${tex}`;
  let html = texCache.get(key);
  if (html === undefined) {
    // throwOnError off: a formula KaTeX cannot read is shown as its source, in red.
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false });
    if (texCache.size > 500) texCache.clear();
    texCache.set(key, html);
  }
  return html;
}

function Tex({ tex, display }: { tex: string; display: boolean }) {
  return (
    <span
      // Sized against the 11px body: KaTeX's own 1.21em reads too large in a narrow column.
      className={display ? "block overflow-x-auto py-1 text-[13px]" : "text-[11.5px]"}
      style={{ scrollbarWidth: "thin" }}
      title={tex}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output — it escapes the TeX it is given
      dangerouslySetInnerHTML={{ __html: texHtml(tex, display) }}
    />
  );
}

/** Text as typed, with any formula in it typeset — the question line. */
export function MathText({ text }: { text: string }) {
  if (!text.includes("$") && !text.includes("\\")) return <>{text}</>;
  return (
    <>
      {splitMath(text).map((span, i) =>
        span.kind === "math" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are derived from the text in order
          <Tex key={i} tex={span.tex} display={span.display} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are derived from the text in order
          <Fragment key={i}>{span.text}</Fragment>
        )
      )}
    </>
  );
}

// ── Inline: math, bold, links, signed percentages ────────────────────────────

const INLINE_RE =
  /(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?<![\w.])[+\-−]\d[\d,]*(?:\.\d+)?\s?%)/g;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Formulas first — what is inside one is TeX, not bold marks or signed percentages. */
function Inline({ text, colors }: { text: string; colors: ThemeColors }) {
  if (!text.includes("$") && !text.includes("\\"))
    return <InlineText text={text} colors={colors} />;
  return (
    <>
      {splitMath(text).map((span, i) =>
        span.kind === "math" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are derived from the text in order
          <Tex key={i} tex={span.tex} display={span.display} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are derived from the text in order
          <InlineText key={i} text={span.text} colors={colors} />
        )
      )}
    </>
  );
}

function InlineText({ text, colors }: { text: string; colors: ThemeColors }) {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(<Fragment key={key++}>{text.slice(last, at)}</Fragment>);
    if (m[1]) {
      out.push(
        <strong key={key++} style={{ fontWeight: 700 }}>
          {m[1].slice(2, -2)}
        </strong>
      );
    } else if (m[2]) {
      // A full URL in running text is noise; the host says where it goes.
      out.push(
        <a
          key={key++}
          href={m[2]}
          target="_blank"
          rel="noopener noreferrer"
          title={m[2]}
          className="font-mono hover:opacity-70"
          style={{ color: colors.accent }}
        >
          ↗{hostOf(m[2])}
        </a>
      );
    } else {
      const up = m[3].startsWith("+");
      out.push(
        <span key={key++} className="font-mono" style={{ color: up ? "#4caf50" : "#ef5350" }}>
          {m[3]}
        </span>
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

// ── Blocks ───────────────────────────────────────────────────────────────────

export function AnswerBody({
  text,
  pending,
  colors,
}: {
  text: string;
  pending?: boolean;
  colors: ThemeColors;
}) {
  const blocks = parseAnswer(text);
  const cursor = pending ? <span className="animate-pulse">▍</span> : null;

  return (
    <div className="flex flex-col">
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are derived from the text in order
        <Block key={i} block={b} end={i === blocks.length - 1 ? cursor : null} colors={colors} />
      ))}
    </div>
  );
}

function Block({
  block: b,
  end,
  colors,
}: { block: AnswerBlock; end: ReactNode; colors: ThemeColors }) {
  if (b.kind === "lead") {
    return (
      <p
        className="text-[11px] pl-2 mb-2 border-l-2"
        style={{ borderColor: colors.accent, color: colors.text, fontWeight: 600 }}
      >
        <Inline text={b.text} colors={colors} />
        {end}
      </p>
    );
  }
  if (b.kind === "math") {
    return (
      <div className="my-1" style={{ color: colors.text }}>
        <Tex tex={b.tex} display />
        {end}
      </div>
    );
  }
  if (b.kind === "heading") {
    return (
      <h4
        className="text-[9px] font-bold tracking-widest mt-3 mb-1 pb-0.5 border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        <MathText text={b.text} />
        {end}
      </h4>
    );
  }
  if (b.kind === "bullet") {
    return (
      <div className="flex gap-2 py-1">
        <span
          className="shrink-0 w-3 text-right font-mono text-[9px] leading-[1.9]"
          style={{ color: colors.accent }}
        >
          {b.marker ?? "▪"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] break-words" style={{ color: colors.text }}>
            <Inline text={b.text} colors={colors} />
            {b.source ? null : end}
          </div>
          {b.source && (
            <div className="text-[8px] break-words" style={{ color: colors.textSecondary }}>
              <Inline text={b.source} colors={colors} />
              {end}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <p className="text-[11px] my-1 break-words" style={{ color: colors.text }}>
      <Inline text={b.text} colors={colors} />
      {end}
    </p>
  );
}
