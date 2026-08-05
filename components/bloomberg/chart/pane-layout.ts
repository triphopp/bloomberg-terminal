/**
 * Sub-pane sizing for ModularChart.
 *
 * Pure functions, kept out of the component so the arithmetic can be tested
 * without React or a canvas. The component owns the side effects (applying the
 * heights to lightweight-charts, reading dragged heights back).
 *
 * Sub-panes used to be a flat 80px each and the chart simply grew taller with
 * every indicator added — past the parent's height it was clipped, which is what
 * made stacked indicators appear to bleed into the volume pane. Instead, fit the
 * panes to the height actually available and only overflow (with a scrollbar)
 * once even the minimums no longer fit.
 */

export const SUB_PANE_MAX = 80;
export const SUB_PANE_MIN = 44; // below this a pane's price scale labels start to collide
/** Ceiling for a *user-dragged* height — the auto layout still caps at SUB_PANE_MAX. */
export const SUB_PANE_USER_MAX = 400;
export const MAIN_PANE_MIN = 140;

/** Keep a restored height sane — a corrupt stored value must not wreck the chart. */
export function clampPaneHeight(h: number): number {
  return Math.max(SUB_PANE_MIN, Math.min(SUB_PANE_USER_MAX, Math.round(h)));
}

/**
 * Storage key for a pane's height: the indicator family, not the instance.
 *
 * Instance ids embed their params ("rsi-14", "macd-12-26-9"), so keying on them
 * would drop the user's height the moment they changed a period. Trailing
 * numeric groups are the params, so stripping them yields the family ("rsi",
 * "macd") while leaving word-hyphenated ids ("bb-width", "fear-greed") alone.
 */
export function paneKey(indicatorId: string): string {
  return indicatorId.replace(/(-\d+(\.\d+)?)+$/, "") || indicatorId;
}

/** Divider lightweight-charts draws between panes — part of locating pane tops. */
export const PANE_SEPARATOR = 1;

/**
 * Which sub-pane sits under a y offset inside the chart container.
 *
 * `paneHeights` is what the chart reports right now — `[main, ...subs]` — not
 * what `computePaneLayout` asked for. A drag changes the real heights without a
 * rebuild, so the requested layout goes stale the moment the user resizes
 * anything.
 *
 * Returns null for the price pane, for a y outside every pane, and for a chart
 * whose panes report zero height (which happens while sub-panes are collapsed —
 * a band of zero width can never be hit, and guessing one would put a menu on a
 * pane the user cannot see).
 */
export function subPaneKeyAtOffset(
  offsetY: number,
  paneHeights: number[],
  subPaneKeys: string[]
): string | null {
  if (subPaneKeys.length === 0) return null;
  if (paneHeights.length !== subPaneKeys.length + 1) return null;

  let top = paneHeights[0] + PANE_SEPARATOR;
  for (let i = 0; i < subPaneKeys.length; i++) {
    const paneHeight = paneHeights[i + 1];
    if (paneHeight > 0 && offsetY >= top && offsetY < top + paneHeight) return subPaneKeys[i];
    top += paneHeight + PANE_SEPARATOR;
  }
  return null;
}

export interface PaneLayout {
  /** Total height handed to lightweight-charts */
  chartHeight: number;
  /** Auto height for panes the user has never resized */
  subPaneHeight: number;
  /** Effective height per pane key, user override applied */
  heightFor: (key: string) => number;
}

export function computePaneLayout(
  available: number,
  paneKeys: string[],
  overrides: Record<string, number>
): PaneLayout {
  const paneCount = paneKeys.length;
  if (paneCount === 0) {
    return { chartHeight: available, subPaneHeight: 0, heightFor: () => 0 };
  }
  // Auto-size only the panes with no user height; the ones the user dragged keep
  // theirs and are simply subtracted from the space the rest get to share.
  const custom = paneKeys.filter((k) => overrides[k] != null);
  const autoCount = paneCount - custom.length;
  const customTotal = custom.reduce((sum, k) => sum + clampPaneHeight(overrides[k]), 0);

  const subPaneHeight =
    autoCount > 0
      ? Math.max(
          SUB_PANE_MIN,
          Math.min(SUB_PANE_MAX, Math.floor((available - MAIN_PANE_MIN - customTotal) / autoCount))
        )
      : 0;

  const heightFor = (key: string) =>
    overrides[key] != null ? clampPaneHeight(overrides[key]) : subPaneHeight;

  // Below this the panes would have to shrink past their minimum, so scroll instead.
  const needed = MAIN_PANE_MIN + customTotal + autoCount * subPaneHeight;
  return { chartHeight: Math.max(available, needed), subPaneHeight, heightFor };
}
