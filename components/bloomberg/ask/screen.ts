/**
 * The view on screen as text, for the model's `read_screen` tool.
 *
 * Read from the DOM when a question is sent, so it is what the user sees at
 * that moment — the tab that is open, the period that is picked, the numbers as
 * displayed — and needs no code in any view. Charts drawn on a canvas are not
 * text and are not in it; the data behind them is what `get_page_data` is for.
 *
 * The shell marks the view area `data-ask-screen`; ASK's own surfaces carry
 * `data-ask-surface` and are left out (the model has the conversation already).
 */

/** Same cap as `SCREEN_CHARS` in backend/ask_pages.py. */
const MAX_CHARS = 24_000;

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "TEMPLATE", "IFRAME"]);

function fieldText(el: Element): string | null {
  if (el instanceof HTMLSelectElement) return `[${el.selectedOptions[0]?.text.trim() ?? ""}▾]`;
  if (el instanceof HTMLTextAreaElement) return el.value ? `[${el.value}]` : "";
  if (el instanceof HTMLInputElement) {
    if (el.type === "password" || el.type === "hidden" || el.type === "file") return "";
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "[x]" : "[ ]";
    return el.value ? `[${el.value}]` : "";
  }
  return null;
}

/**
 * Children of a row sit side by side, children of anything else stack. That is
 * all the layout the text keeps — enough for a table row to stay one line with
 * its label next to its numbers.
 */
function walk(el: Element, out: string[]): void {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return;
  if (el.hasAttribute("data-ask-surface") || el.getAttribute("aria-hidden") === "true") return;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return;

  const field = fieldText(el);
  if (field !== null) {
    out.push(field);
    return;
  }

  const row =
    ((style.display === "flex" || style.display === "inline-flex") &&
      !style.flexDirection.startsWith("column")) ||
    style.display === "table-row" ||
    style.display === "grid";
  // What is switched on — the open tab, the chosen range — is marked, since colour does not survive.
  const on =
    el.getAttribute("aria-selected") === "true" ||
    el.getAttribute("aria-pressed") === "true" ||
    el.getAttribute("aria-current") === "page";
  if (on) out.push("▶");

  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.replace(/\s+/g, " ") ?? "";
      if (text.trim()) out.push(text);
    } else if (node instanceof Element) {
      const inline = getComputedStyle(node).display.startsWith("inline");
      if (!inline) out.push(row ? "\t" : "\n");
      walk(node, out);
      if (!inline) out.push(row ? "\t" : "\n");
    }
  }
}

/** Text of the view the user has open, or "" when there is none to read. */
export function readScreen(): string {
  if (typeof document === "undefined") return "";
  const root = document.querySelector("[data-ask-screen]");
  if (!root) return "";
  const out: string[] = [];
  try {
    walk(root, out);
  } catch {
    return "";
  }
  const text = out
    .join("")
    .replace(/[ \t]*\t[ \t]*/g, " | ")
    .replace(/(?: \| )+(?=\n|$)/g, "")
    .replace(/(^|\n)(?: \| )+/g, "$1")
    .replace(/(?: \| ){2,}/g, " | ")
    .replace(/ *\n[\s|]*/g, "\n")
    .trim();
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… [screen text cut here]` : text;
}
