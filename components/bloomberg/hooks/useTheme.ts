"use client";

import { useAtom } from "jotai";
import { useMemo } from "react";
import { isDarkModeAtom } from "../atoms";
import { bloombergColors, getStyles } from "../lib/theme-config";
import type { ThemeColors, ThemeStyles } from "../lib/theme-config";

export interface Theme {
  isDark:  boolean;
  colors:  ThemeColors;
  styles:  ThemeStyles;
}

/**
 * Single hook for all Bloomberg Terminal styling.
 *
 * Usage:
 *   const { colors, styles, isDark } = useTheme();
 *
 *   // Inline style (component presets)
 *   <div style={styles.panelHeader}>...</div>
 *
 *   // Individual token
 *   <span style={{ color: colors.accent }}>AAPL</span>
 *
 *   // Tailwind class (CSS var layer)
 *   <div className="bg-bb-surface border-b border-bb-border">...</div>
 */
export function useTheme(): Theme {
  const [isDark] = useAtom(isDarkModeAtom);
  const colors = isDark ? bloombergColors.dark : bloombergColors.light;
  const styles = useMemo(() => getStyles(colors), [colors]);
  return { isDark, colors, styles };
}
