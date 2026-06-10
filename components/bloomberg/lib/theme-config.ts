import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ── Color Tokens ──────────────────────────────────────────────────────────────
//
// Single source of truth for all Bloomberg Terminal colors.
// Views should reference tokens by name — never hardcode hex values inline.
//
// Migration note:
//   Old name        → New name
//   colors.surface  → colors.surface  (unchanged)
//   colors.background → still works (alias for colors.bg)

export interface ThemeColors {
  // Backgrounds
  bg:           string;
  background:   string;  // alias for bg — backward compat
  surface:      string;
  surfaceDeep:  string;
  bgHover:      string;
  bgSelected:   string;

  // Borders
  border:       string;
  borderMid:    string;
  borderFaint:  string;

  // Text
  text:          string;
  textSecondary: string;
  textDimmed:    string;
  textDisabled:  string;

  // Accent
  accent:         string;
  accentSelected: string;
  accentBlue:     string;
  accentWarn:     string;

  // Status: real-time tickers (bright, high contrast)
  positive:     string;
  negative:     string;

  // Status: summary / aggregate (softer)
  positiveAlt:  string;
  negativeAlt:  string;
  positiveMuted: string;
  negativeMuted: string;

  // Specialised
  priceValue:    string;
  sparklineGray: string;
  volumeHigh:    string;
  volumeAvg:     string;
  volumeLow:     string;

  // Legacy
  header: string;
}

const dark: ThemeColors = {
  bg:           "#000000",
  background:   "#000000",   // alias
  surface:      "#0d0d0d",
  surfaceDeep:  "#050505",
  bgHover:      "#111111",
  bgSelected:   "#0a1628",

  border:       "#1f1f1f",
  borderMid:    "#222222",
  borderFaint:  "#0f0f0f",

  text:          "#ffffff",
  textSecondary: "#888888",
  textDimmed:    "#555555",
  textDisabled:  "#333333",

  accent:          "#FF6600",
  accentSelected:  "#00FFFF",
  accentBlue:      "#42a5f5",
  accentWarn:      "#FF6600",

  positive:        "#00FF00",
  negative:        "#FF0000",
  positiveAlt:     "#4ade80",
  negativeAlt:     "#f87171",
  positiveMuted:   "#4CAF50",
  negativeMuted:   "#F44336",

  priceValue:    "#FFD700",
  sparklineGray: "#666666",
  volumeHigh:    "#ff990044",
  volumeAvg:     "#4ade8033",
  volumeLow:     "#33333344",

  header: "#000000",
};

const light: ThemeColors = {
  bg:           "#f5f5f5",
  background:   "#f5f5f5",   // alias
  surface:      "#eeeeee",
  surfaceDeep:  "#e8e8e8",
  bgHover:      "#dddddd",
  bgSelected:   "#ddeeff",

  border:       "#cccccc",
  borderMid:    "#bbbbbb",
  borderFaint:  "#e0e0e0",

  text:          "#111111",
  textSecondary: "#666666",
  textDimmed:    "#999999",
  textDisabled:  "#bbbbbb",

  accent:          "#e68a00",
  accentSelected:  "#0088cc",
  accentBlue:      "#1565c0",
  accentWarn:      "#f57c00",

  positive:        "#2e7d32",
  negative:        "#c62828",
  positiveAlt:     "#388e3c",
  negativeAlt:     "#d32f2f",
  positiveMuted:   "#2e7d32",
  negativeMuted:   "#c62828",

  priceValue:    "#5d4e00",
  sparklineGray: "#888888",
  volumeHigh:    "#e6890044",
  volumeAvg:     "#2e7d3233",
  volumeLow:     "#cccccc44",

  header: "#e8e8e8",
};

export const bloombergColors = { dark, light };

// ── Component Style Presets ───────────────────────────────────────────────────
//
// Pre-built inline style objects for common Bloomberg UI patterns.
// Usage:
//   const { styles } = useTheme();
//   <div style={styles.panelHeader}>...</div>
//
// Change a token above → every component using these presets updates.

export function getStyles(c: ThemeColors) {
  return {
    // ── Container layers ────────────────────────────────────────────────────
    canvas: {
      backgroundColor: c.bg,
      color: c.text,
    } as React.CSSProperties,

    // ── Panel headers (top bar of every panel / section) ─────────────────────
    panelHeader: {
      background: c.surface,
      borderBottom: `1px solid ${c.border}`,
    } as React.CSSProperties,

    panelHeaderDeep: {
      background: c.surfaceDeep,
      borderBottom: `1px solid ${c.border}`,
    } as React.CSSProperties,

    // ── Table header (sticky column-label row) ───────────────────────────────
    tableHeader: {
      background: c.surfaceDeep,
      borderBottom: `1px solid ${c.border}`,
      color: c.textDimmed,
    } as React.CSSProperties,

    // ── Data rows ────────────────────────────────────────────────────────────
    dataRow: {
      borderBottom: `1px solid ${c.border}`,
    } as React.CSSProperties,

    dataRowSelected: {
      background: c.bgSelected,
      borderBottom: `1px solid ${c.border}`,
      borderLeft: `2px solid ${c.accentSelected}`,
    } as React.CSSProperties,

    // ── Section sub-header ("AMERICAS", "EMEA" inside tables) ────────────────
    sectionSubheader: {
      background: c.surfaceDeep,
      color: c.accent,
      borderBottom: `1px solid ${c.border}`,
    } as React.CSSProperties,

    // ── Sidebar / secondary surface ──────────────────────────────────────────
    sidebar: {
      background: c.surface,
      borderRight: `1px solid ${c.border}`,
    } as React.CSSProperties,

    // ── Buttons ──────────────────────────────────────────────────────────────
    btnActive: {
      background: c.accent,
      color: "#000",
      border: `1px solid ${c.accent}`,
    } as React.CSSProperties,

    btnInactive: {
      background: "transparent",
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    } as React.CSSProperties,

    btnDanger: {
      background: "#ef444422",
      color: "#f87171",
      border: "1px solid #ef444444",
    } as React.CSSProperties,

    btnSuccess: {
      background: "#22c55e22",
      color: "#4ade80",
      border: "1px solid #22c55e44",
    } as React.CSSProperties,

    // ── Input / command box ──────────────────────────────────────────────────
    commandInput: {
      background: c.bg,
      color: c.accent,
      border: `1px solid ${c.border}`,
      fontFamily: "monospace",
    } as React.CSSProperties,

    // ── Dropdown / popover ───────────────────────────────────────────────────
    dropdown: {
      backgroundColor: c.surface,
      border: `1px solid ${c.border}`,
    } as React.CSSProperties,

    // ── Chart tooltip ────────────────────────────────────────────────────────
    chartTooltip: {
      backgroundColor: "#111",
      borderColor: c.border,
      color: c.text,
      fontSize: 10,
      fontFamily: "monospace",
      borderRadius: 0,
      padding: "4px 6px",
    } as React.CSSProperties,

    // ── Scrollable areas ─────────────────────────────────────────────────────
    scrollArea: {
      scrollbarWidth: "thin" as const,
      scrollbarColor: "#333 #000",
    } as React.CSSProperties,

    // ── Resize divider ───────────────────────────────────────────────────────
    resizeDivider: {
      background: c.border,
    } as React.CSSProperties,

    // ── Status badges ────────────────────────────────────────────────────────
    badgePositive: {
      background: "#00FF0015",
      color: "#00FF00",
      border: "1px solid #00FF0033",
    } as React.CSSProperties,

    badgeNegative: {
      background: "#FF000015",
      color: "#FF0000",
      border: "1px solid #FF000033",
    } as React.CSSProperties,

    badgeNeutral: {
      background: c.surfaceDeep,
      color: c.textSecondary,
      border: `1px solid ${c.border}`,
    } as React.CSSProperties,
  };
}

export type ThemeStyles = ReturnType<typeof getStyles>;
