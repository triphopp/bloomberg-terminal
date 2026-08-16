import type { Colors } from "../../helpers";

// Minimal markdown renderer, carried over from the file-based ThesesTab: the
// thesis body is authored as markdown in Obsidian and must render the same here.

function renderInline(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, j) => {
    const k = `${j}-${part.slice(0, 8)}`;
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={k}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={k}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function renderMarkdown(text: string, colors: Colors) {
  return text.split("\n").map((line, i) => {
    const k = `${i}-${line.slice(0, 12)}`;
    if (line.startsWith("### "))
      return (
        <h4 key={k} className="font-bold text-xs mt-3 mb-1" style={{ color: colors.accent }}>
          {line.slice(4)}
        </h4>
      );
    if (line.startsWith("## "))
      return (
        <h3 key={k} className="font-bold text-sm mt-4 mb-1" style={{ color: colors.accent }}>
          {line.slice(3)}
        </h3>
      );
    if (line.startsWith("- "))
      return (
        <li key={k} className="text-xs ml-3 mb-0.5" style={{ color: colors.textSecondary }}>
          {renderInline(line.slice(2))}
        </li>
      );
    if (line.trim())
      return (
        <p key={k} className="text-xs mb-1 leading-relaxed" style={{ color: colors.textSecondary }}>
          {renderInline(line)}
        </p>
      );
    return <br key={k} />;
  });
}
