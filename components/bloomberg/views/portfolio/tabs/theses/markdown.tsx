import type { ReactNode } from "react";
import type { Colors } from "../../helpers";

// Markdown renderer for anything written in the thesis workspace — the thesis
// body, a zettel, a note. The text is authored in Obsidian and has to render
// the same here, so the earlier version (headings, `- `, **bold** and nothing
// else) silently swallowed tables, links and numbered lists: the two things a
// research note is mostly made of.
//
// Two densities share one renderer. "dense" is the terminal's own 9–12px
// typography; "read" is the document mode, where the same note is meant to be
// read end to end rather than scanned.

export type MdScale = "dense" | "read";

type Sizes = {
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  body: string;
  small: string;
  gap: string;
};

const SIZES: Record<MdScale, Sizes> = {
  dense: {
    h1: "text-sm",
    h2: "text-sm",
    h3: "text-xs",
    h4: "text-[11px]",
    body: "text-xs",
    small: "text-[10px]",
    gap: "mb-1",
  },
  read: {
    h1: "text-[22px]",
    h2: "text-[17px]",
    h3: "text-[15px]",
    h4: "text-[14px]",
    body: "text-[13.5px]",
    small: "text-[12px]",
    gap: "mb-2",
  },
};

// ── Inline ───────────────────────────────────────────────────────────────────
// Split on the whole set at once so `**bold [link](url)**` does not lose the
// link, and so a `*` inside a URL cannot open an emphasis run.
const INLINE =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\)|https?:\/\/\S+)/g;

function renderInline(text: string, colors: Colors, scale: MdScale): ReactNode[] {
  return text.split(INLINE).map((part, j) => {
    const k = `${j}-${part.slice(0, 10)}`;
    if (!part) return null;

    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code
          key={k}
          className="px-1 font-mono"
          style={{ background: "#ffffff0d", color: colors.accent }}
        >
          {part.slice(1, -1)}
        </code>
      );

    if (part.startsWith("**") && part.endsWith("**"))
      return (
        <strong key={k} style={{ color: colors.text }}>
          {part.slice(2, -2)}
        </strong>
      );

    if (part.startsWith("~~") && part.endsWith("~~"))
      return (
        <span key={k} className="line-through" style={{ opacity: 0.6 }}>
          {part.slice(2, -2)}
        </span>
      );

    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={k}>{part.slice(1, -1)}</em>;

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link)
      return (
        <a
          key={k}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
          style={{ color: colors.accent }}
        >
          {link[1]}
        </a>
      );

    if (/^https?:\/\//.test(part))
      return (
        <a
          key={k}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          className="underline break-all"
          style={{ color: colors.accent }}
        >
          {part}
        </a>
      );

    return part;
  });
}

// ── Block ────────────────────────────────────────────────────────────────────

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Render markdown. `scale` picks terminal density or document typography. */
export function renderMarkdown(text: string, colors: Colors, scale: MdScale = "dense") {
  const s = SIZES[scale];
  const lines = (text ?? "").split("\n");
  const out: ReactNode[] = [];

  // Consecutive list items become one <ul>/<ol>, so the browser (not a stack of
  // orphan <li>) owns the indentation and the markers line up.
  let list: { ordered: boolean; items: { depth: number; text: string }[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    list = null;
    const Tag = ordered ? "ol" : "ul";
    out.push(
      <Tag
        key={`list-${out.length}`}
        className={`${s.body} ${s.gap} ${ordered ? "list-decimal" : "list-disc"} pl-5 space-y-0.5`}
        style={{ color: colors.textSecondary }}
      >
        {items.map((it, i) => (
          <li
            key={`${i}-${it.text.slice(0, 12)}`}
            style={{ marginLeft: it.depth * (scale === "read" ? 16 : 10) }}
          >
            {renderInline(it.text, colors, scale)}
          </li>
        ))}
      </Tag>
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // fenced code — copied through verbatim, including the blank lines inside
    if (trimmed.startsWith("```")) {
      flushList();
      const lang = trimmed.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) body.push(lines[i++]);
      out.push(
        <pre
          key={`code-${out.length}`}
          className={`${s.small} ${s.gap} font-mono p-2 overflow-x-auto`}
          style={{ background: "#ffffff08", border: `1px solid ${colors.border}` }}
        >
          {lang && (
            <div className="text-[9px] mb-1" style={{ color: colors.textSecondary }}>
              {lang}
            </div>
          )}
          <code style={{ color: colors.text }}>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // GFM table — header row followed by a divider row
    if (trimmed.includes("|") && TABLE_DIVIDER.test(lines[i + 1] ?? "")) {
      flushList();
      const head = splitRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i].trim()));
        i++;
      }
      i--;
      out.push(
        <div key={`tbl-${out.length}`} className={`${s.gap} overflow-x-auto`}>
          <table className={`${s.small} w-full`} style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th
                    key={`${c}-${h}`}
                    className="text-left px-1.5 py-1 font-bold"
                    style={{
                      color: colors.textSecondary,
                      borderBottom: `1px solid ${colors.border}`,
                      background: "#ffffff06",
                    }}
                  >
                    {renderInline(h, colors, scale)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={`${ri}-${r[0] ?? ""}`}>
                  {r.map((c, ci) => (
                    <td
                      key={`${ci}-${c.slice(0, 8)}`}
                      className="px-1.5 py-1 align-top"
                      style={{ color: colors.text, borderBottom: "1px solid #1a1a1a" }}
                    >
                      {renderInline(c, colors, scale)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // horizontal rule
    if (/^(---|___|\*\*\*)\s*$/.test(trimmed)) {
      flushList();
      out.push(
        <hr key={`hr-${out.length}`} className="my-3" style={{ borderColor: colors.border }} />
      );
      continue;
    }

    // blockquote
    if (trimmed.startsWith("> ")) {
      flushList();
      out.push(
        <blockquote
          key={`q-${out.length}`}
          className={`${s.body} ${s.gap} pl-2`}
          style={{ borderLeft: `2px solid ${colors.accent}`, color: colors.textSecondary }}
        >
          {renderInline(trimmed.slice(2), colors, scale)}
        </blockquote>
      );
      continue;
    }

    // headings — the id lets the READ mode's table of contents jump here
    const head = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (head) {
      flushList();
      const level = head[1].length;
      const body = head[2];
      const cls = level === 1 ? s.h1 : level === 2 ? s.h2 : level === 3 ? s.h3 : s.h4;
      const Tag = `h${Math.min(level + 1, 6)}` as unknown as "h2";
      out.push(
        <Tag
          key={`h-${out.length}`}
          id={slugifyHeading(body)}
          className={`${cls} font-bold ${scale === "read" ? "mt-6 mb-2" : "mt-3 mb-1"} scroll-mt-4`}
          style={{ color: colors.accent }}
        >
          {renderInline(body, colors, scale)}
        </Tag>
      );
      continue;
    }

    // list items — "- ", "* ", "1. ", with two-space indent per level
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const depth = Math.floor(li[1].length / 2);
      const ordered = /\d/.test(li[2]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push({ depth, text: li[3] });
      continue;
    }

    if (!trimmed) {
      flushList();
      out.push(<div key={`sp-${out.length}`} className={scale === "read" ? "h-3" : "h-1.5"} />);
      continue;
    }

    flushList();
    out.push(
      <p
        key={`p-${out.length}`}
        className={`${s.body} ${s.gap} leading-relaxed`}
        style={{ color: colors.textSecondary, lineHeight: scale === "read" ? 1.75 : undefined }}
      >
        {renderInline(trimmed, colors, scale)}
      </p>
    );
  }

  flushList();
  return out;
}

/** Stable anchor for a heading — shared by the renderer and the READ table of
 *  contents, so both sides agree without passing ids around. */
export function slugifyHeading(text: string): string {
  return `h-${text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)}`;
}

/** The `##`/`###` headings of a markdown body, for a table of contents. */
export function headingsOf(text: string): { level: number; title: string; id: string }[] {
  const out: { level: number; title: string; id: string }[] = [];
  let fenced = false;
  for (const line of (text ?? "").split("\n")) {
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (m) out.push({ level: m[1].length, title: m[2], id: slugifyHeading(m[2]) });
  }
  return out;
}
