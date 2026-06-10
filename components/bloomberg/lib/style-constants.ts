// Shared inline style constants — replaces repeated object literals that create
// new JS objects every render cycle.  Use these instead of style={{...}} for
// common patterns.

// ── Scrollbar (always dark, never changes with theme) ──────────────

export const SCROLLBAR_THIN = {
  scrollbarWidth: "thin",
  scrollbarColor: "#222 #000",
} as const;

export const SCROLLBAR_THIN_LIGHTER = {
  scrollbarWidth: "thin",
  scrollbarColor: "#333 #000",
} as const;

// ── Text presets (color comes from bloombergColors, rest is fixed) ─

export function panelBase(c: { surface: string; border: string }) {
  return PANEL_BASE(c.surface, c.border);
}

function PANEL_BASE(bg: string, bd: string) {
  return { backgroundColor: bg, border: `1px solid ${bd}` } as const;
}

export function textMuted(c: { textSecondary: string }) {
  return {
    color: c.textSecondary,
    fontFamily: "monospace",
    fontSize: "9px",
  } as const;
}

export function textLabel(c: { textSecondary: string }) {
  return {
    color: c.textSecondary,
    fontFamily: "monospace",
    fontSize: "8px",
    fontWeight: "bold",
    letterSpacing: "0.05em",
  } as const;
}

// ── Common layout presets ───────────────────────────────────────────

export const FLEX_CENTER = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

export const MONO_FONT = { fontFamily: "monospace" } as const;
