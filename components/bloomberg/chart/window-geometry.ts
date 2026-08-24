/**
 * Geometry + stacking rules for floating chart windows.
 *
 * Dependency-free on purpose: the atoms module wires these into jotai, but the
 * rules themselves are pure so they can be tested with `node --test` without a
 * DOM or a store.
 */

export const MAX_CHART_WINDOWS = 10;

export const DEFAULT_WINDOW_W = 520;
export const DEFAULT_WINDOW_H = 360;
export const MIN_WINDOW_W = 320;
export const MIN_WINDOW_H = 220;
/** Height of the title bar — a minimized window collapses to exactly this. */
export const TITLE_BAR_H = 22;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Screen-space bounds of a detached (real) browser window.
 *
 * Distinct from `Rect`: those are page coordinates inside the terminal tab,
 * these are OS screen coordinates and can be negative or beyond the primary
 * screen when the window lives on a second monitor. Nothing clamps them — the
 * window manager already decides what is reachable.
 */
export interface NativeBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Next free stacking index, one above the current top window. */
export function nextZ(list: { z: number }[]): number {
  return list.reduce((max, w) => Math.max(max, w.z), 0) + 1;
}

/**
 * Where a newly opened window goes.
 *
 * Cascades by `count` so a burst of opens doesn't pile every window on one
 * spot, wrapping every 8 so the diagonal never walks off the screen, then
 * clamps into the viewport.
 */
export function cascadeOrigin(
  count: number,
  viewport: Viewport,
  /** Size of the window being placed — a larger one has to start further up/left. */
  size: { w: number; h: number } = { w: DEFAULT_WINDOW_W, h: DEFAULT_WINDOW_H }
): { x: number; y: number } {
  const step = 28;
  const slot = ((count % 8) + 8) % 8;
  const x = Math.min(120 + slot * step, Math.max(0, viewport.width - size.w - 16));
  const y = Math.min(90 + slot * step, Math.max(0, viewport.height - size.h - 16));
  return { x, y };
}

/**
 * Keep a window fully reachable inside the viewport.
 *
 * Clamps size first, then position, so a window restored from localStorage on a
 * smaller screen (or left off-screen after the browser shrank) still has its
 * title bar — and therefore its drag handle and close button — on screen. The
 * body may hang off the bottom/right edge; the title bar may not leave.
 */
export function clampWindow(geo: Rect, viewport: Viewport): Rect {
  const w = Math.max(MIN_WINDOW_W, Math.min(geo.w, Math.max(MIN_WINDOW_W, viewport.width)));
  const h = Math.max(MIN_WINDOW_H, Math.min(geo.h, Math.max(MIN_WINDOW_H, viewport.height)));
  const x = Math.max(-w + 80, Math.min(geo.x, viewport.width - 80));
  const y = Math.max(0, Math.min(geo.y, Math.max(0, viewport.height - TITLE_BAR_H)));
  return { x, y, w, h };
}

/**
 * Where a window for `symbol` should open.
 *
 * Priority: the geometry that symbol was last left at, then the size of the
 * last window the user shaped (so a new symbol inherits the shape they like)
 * with a cascaded position. Everything is clamped, so a layout remembered on a
 * bigger screen still lands somewhere reachable.
 */
export function resolveOpenGeometry(
  remembered: Rect | undefined,
  lastSize: { w: number; h: number } | undefined,
  count: number,
  viewport: Viewport
): Rect {
  if (remembered) return clampWindow(remembered, viewport);
  const size = {
    w: lastSize?.w ?? DEFAULT_WINDOW_W,
    h: lastSize?.h ?? DEFAULT_WINDOW_H,
  };
  const { x, y } = cascadeOrigin(count, viewport, size);
  return clampWindow({ x, y, ...size }, viewport);
}

/**
 * How many per-symbol layouts to keep. Bounded because this map is persisted
 * and every symbol ever popped out would otherwise stay in localStorage for
 * good; 40 is far more than any desk arrangement needs.
 */
export const MAX_REMEMBERED_LAYOUTS = 40;

/**
 * Record `symbol`'s layout, keeping the map bounded and ordered by recency.
 *
 * Re-inserting the key moves it to the end, so the oldest entries are the ones
 * dropped once the map is full.
 */
export function rememberLayout(
  map: Record<string, Rect>,
  symbol: string,
  rect: Rect,
  max = MAX_REMEMBERED_LAYOUTS
): Record<string, Rect> {
  const next: Record<string, Rect> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key !== symbol) next[key] = value;
  }
  next[symbol] = rect;

  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  const trimmed: Record<string, Rect> = {};
  for (const key of keys.slice(keys.length - max)) trimmed[key] = next[key];
  return trimmed;
}

/** True when a patch carries any geometry field worth remembering. */
export function hasGeometry(patch: Partial<Rect>): patch is Rect {
  return (
    patch.x !== undefined && patch.y !== undefined && patch.w !== undefined && patch.h !== undefined
  );
}

/**
 * Whether opening `symbol` would create a new window.
 *
 * Re-opening a symbol that already has one just focuses it, so the cap must not
 * block that case — only genuinely new windows count against it.
 */
export function canOpenWindow(list: { symbol: string }[], symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (!s) return false;
  if (list.some((w) => w.symbol === s)) return true;
  return list.length < MAX_CHART_WINDOWS;
}
