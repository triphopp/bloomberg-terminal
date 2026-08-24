import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { BarInterval, TimePeriod } from "../chart/types";
import type { NativeBounds, Rect } from "../chart/window-geometry";
import {
  DEFAULT_WINDOW_H,
  DEFAULT_WINDOW_W,
  MAX_CHART_WINDOWS,
  hasGeometry,
  nextZ,
  rememberLayout,
  resolveOpenGeometry,
} from "../chart/window-geometry";

/**
 * Floating chart windows — Bloomberg-style multi-chart popups.
 *
 * Each entry is one free-floating window rendered by <ChartWindowLayer /> at the
 * terminal root, so the windows survive view switches (MKT → MACRO → …).
 * Geometry and symbol persist; live data does not — React Query owns that and
 * dedupes by queryKey, so N windows on one symbol still make one request.
 *
 * The geometry and stacking rules live in `chart/window-geometry` so they stay
 * testable without a store.
 */

export {
  MAX_CHART_WINDOWS,
  DEFAULT_WINDOW_W,
  DEFAULT_WINDOW_H,
  MIN_WINDOW_W,
  MIN_WINDOW_H,
  TITLE_BAR_H,
  clampWindow,
  canOpenWindow,
} from "../chart/window-geometry";

export interface ChartWindowState {
  id: string;
  symbol: string;
  /** Display name shown next to the ticker. Falls back to the symbol. */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Stacking order — highest is on top. Rewritten on focus. */
  z: number;
  minimized: boolean;
  /**
   * Running in a real `window.open` window instead of an in-page box.
   *
   * Reset to false when the terminal loads: reopening a native window needs a
   * user gesture, so a detached chart comes back docked and is one click from
   * being detached again.
   */
  detached?: boolean;
  timePeriod: TimePeriod;
  barInterval: BarInterval;
}

export const chartWindowsAtom = atomWithStorage<ChartWindowState[]>(
  "bloomberg_chart_windows",
  [],
  undefined,
  { getOnInit: true }
);

/**
 * Where each symbol's window was last left, kept after the window is closed.
 *
 * Without this, closing a chart and popping the same symbol again dropped it
 * back on the cascade origin — the arrangement the user built for a comparison
 * was lost the moment one window in it was closed and reopened.
 */
export const chartWindowLayoutsAtom = atomWithStorage<Record<string, Rect>>(
  "bloomberg_chart_window_layouts",
  {},
  undefined,
  { getOnInit: true }
);

/**
 * Size of the last window the user shaped. A symbol with no remembered layout
 * opens at this size (cascaded position), so the size only has to be set once
 * rather than on every new popup.
 */
export const chartWindowSizeAtom = atomWithStorage<{ w: number; h: number }>(
  "bloomberg_chart_window_size",
  { w: DEFAULT_WINDOW_W, h: DEFAULT_WINDOW_H },
  undefined,
  { getOnInit: true }
);

/**
 * Where each symbol's DETACHED window was last seen, in screen coordinates.
 * Kept apart from the in-page layouts: the two coordinate systems are not
 * interchangeable, and a chart can have a remembered spot in both.
 */
export const chartWindowNativeBoundsAtom = atomWithStorage<Record<string, NativeBounds>>(
  "bloomberg_chart_window_native",
  {},
  undefined,
  { getOnInit: true }
);

export const rememberNativeBoundsAtom = atom(
  null,
  (get, set, payload: { symbol: string; bounds: NativeBounds }) => {
    const current = get(chartWindowNativeBoundsAtom)[payload.symbol];
    const b = payload.bounds;
    if (
      current &&
      current.left === b.left &&
      current.top === b.top &&
      current.width === b.width &&
      current.height === b.height
    ) {
      return; // sampled on a timer — do not write a storage entry per tick
    }
    set(chartWindowNativeBoundsAtom, { ...get(chartWindowNativeBoundsAtom), [payload.symbol]: b });
  }
);

/**
 * Drop the detached flag from every window. Called once when the layer mounts:
 * the native windows from the previous session are gone, and only a click can
 * open new ones.
 */
export const dockAllChartWindowsAtom = atom(null, (get, set) => {
  const list = get(chartWindowsAtom);
  if (!list.some((w) => w.detached)) return;
  set(
    chartWindowsAtom,
    list.map((w) => (w.detached ? { ...w, detached: false } : w))
  );
});

function currentViewport() {
  return typeof window === "undefined"
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight };
}

export interface OpenChartWindowInput {
  symbol: string;
  label?: string;
  timePeriod?: TimePeriod;
  barInterval?: BarInterval;
}

/**
 * Open a window for `symbol`. Opening a symbol that already has a window just
 * focuses (and un-minimizes) the existing one rather than making a duplicate —
 * duplicates of one ticker are not what the cap should be spent on.
 * At MAX_CHART_WINDOWS a genuinely new window is a no-op.
 */
export const openChartWindowAtom = atom(null, (get, set, input: OpenChartWindowInput) => {
  const list = get(chartWindowsAtom);
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) return;

  const existing = list.find((w) => w.symbol === symbol);
  if (existing) {
    const z = nextZ(list);
    set(
      chartWindowsAtom,
      list.map((w) => (w.id === existing.id ? { ...w, z, minimized: false } : w))
    );
    return;
  }

  if (list.length >= MAX_CHART_WINDOWS) return;

  const geo = resolveOpenGeometry(
    get(chartWindowLayoutsAtom)[symbol],
    get(chartWindowSizeAtom),
    list.length,
    currentViewport()
  );

  set(chartWindowsAtom, [
    ...list,
    {
      id: `cw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol,
      label: input.label?.trim() || symbol,
      ...geo,
      z: nextZ(list),
      minimized: false,
      timePeriod: input.timePeriod ?? "3m",
      barInterval: input.barInterval ?? "1d",
    },
  ]);
});

export const closeChartWindowAtom = atom(null, (get, set, id: string) => {
  set(
    chartWindowsAtom,
    get(chartWindowsAtom).filter((w) => w.id !== id)
  );
});

export const closeAllChartWindowsAtom = atom(null, (_get, set) => {
  set(chartWindowsAtom, []);
});

/** Raise one window to the top of the stack. No-op if it is already there. */
export const focusChartWindowAtom = atom(null, (get, set, id: string) => {
  const list = get(chartWindowsAtom);
  const target = list.find((w) => w.id === id);
  if (!target) return;
  const top = list.reduce((max, w) => Math.max(max, w.z), 0);
  if (target.z === top) return;
  const z = top + 1;
  set(
    chartWindowsAtom,
    list.map((w) => (w.id === id ? { ...w, z } : w))
  );
});

/**
 * Apply a patch to one window, and remember its geometry when the patch carries
 * one. Remembering here rather than on close means a layout survives a crash,
 * a reload, or CLOSE ALL — not just an orderly close.
 */
export const patchChartWindowAtom = atom(
  null,
  (get, set, payload: { id: string; patch: Partial<Omit<ChartWindowState, "id">> }) => {
    const list = get(chartWindowsAtom);
    const target = list.find((w) => w.id === payload.id);
    if (!target) return;

    set(
      chartWindowsAtom,
      list.map((w) => (w.id === payload.id ? { ...w, ...payload.patch } : w))
    );

    if (hasGeometry(payload.patch)) {
      const { x, y, w, h } = payload.patch;
      set(
        chartWindowLayoutsAtom,
        rememberLayout(get(chartWindowLayoutsAtom), target.symbol, { x, y, w, h })
      );
      const size = get(chartWindowSizeAtom);
      if (size.w !== w || size.h !== h) set(chartWindowSizeAtom, { w, h });
    }
  }
);

export const toggleChartWindowMinimizedAtom = atom(null, (get, set, id: string) => {
  set(
    chartWindowsAtom,
    get(chartWindowsAtom).map((w) => (w.id === id ? { ...w, minimized: !w.minimized } : w))
  );
});
