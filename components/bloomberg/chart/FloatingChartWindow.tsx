"use client";

import { useSetAtom } from "jotai";
import { ChevronDown, ChevronUp, ExternalLink, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  type ChartWindowState,
  closeChartWindowAtom,
  focusChartWindowAtom,
  patchChartWindowAtom,
  toggleChartWindowMinimizedAtom,
} from "../atoms/chart-windows";
import { bloombergColors } from "../lib/theme-config";
import { ChartPanel } from "./ChartPanel";
import { useWindowDrag } from "./useWindowDrag";

const colors = bloombergColors.dark;

interface Props {
  win: ChartWindowState;
}

/**
 * One free-floating chart popup, drawn inside the page.
 *
 * The body is the shared <ChartPanel>, so it is the MKT chart panel: quote
 * header, indicator bar, timeframe bar, chart and OHLC footer. The only chrome
 * this adds is the window controls, which ride at the right end of the panel's
 * header row — that row doubles as the drag handle.
 *
 * Indicators come from the same global spec atoms the MKT chart uses, so every
 * chart shows one indicator set. Per-window state is symbol, timeframe and
 * geometry. Scoping indicators per window is a later phase (see
 * memory/plans/floating-chart-windows.md).
 */
function FloatingChartWindowInner({ win }: Props) {
  const patch = useSetAtom(patchChartWindowAtom);
  const close = useSetAtom(closeChartWindowAtom);
  const focus = useSetAtom(focusChartWindowAtom);
  const toggleMin = useSetAtom(toggleChartWindowMinimizedAtom);

  const onFocus = useCallback(() => focus(win.id), [focus, win.id]);

  const { x, y, w, h, isGesturing, isResizing, beginDrag, beginResize } = useWindowDrag({
    geometry: { x: win.x, y: win.y, w: win.w, h: win.h },
    onCommit: (geo) => patch({ id: win.id, patch: geo }),
    onFocus,
    resizable: !win.minimized,
  });

  // ModularChart tears down and rebuilds the whole lightweight-charts instance
  // whenever its measured height changes, so a resize drag would rebuild it
  // once per 8px of travel. Freeze the chart body at the height it had when the
  // gesture started and let it re-measure once, on release.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [frozenBodyHeight, setFrozenBodyHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!isResizing) {
      setFrozenBodyHeight(null);
      return;
    }
    setFrozenBodyHeight((prev) => prev ?? bodyRef.current?.getBoundingClientRect().height ?? null);
  }, [isResizing]);

  const controls = (
    <>
      <button
        type="button"
        data-no-drag
        aria-label="Detach chart into its own window"
        title="Detach into a real browser window — drag it to any monitor"
        className="px-0.5"
        style={{ color: colors.textSecondary }}
        onClick={() => patch({ id: win.id, patch: { detached: true, minimized: false } })}
      >
        <ExternalLink className="h-3 w-3" />
      </button>
      <button
        type="button"
        data-no-drag
        aria-label={win.minimized ? "Expand chart window" : "Collapse chart window"}
        className="px-0.5"
        style={{ color: colors.textSecondary }}
        onClick={() => toggleMin(win.id)}
      >
        {win.minimized ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
      </button>
      <button
        type="button"
        data-no-drag
        aria-label="Close chart window"
        className="px-0.5"
        style={{ color: colors.textSecondary }}
        onClick={() => close(win.id)}
      >
        <X className="h-3 w-3" />
      </button>
    </>
  );

  return (
    <div
      ref={bodyRef}
      className="absolute flex flex-col pointer-events-auto"
      style={{
        left: x,
        top: y,
        width: w,
        height: win.minimized ? undefined : h,
        zIndex: win.z,
        background: "#050505",
        border: `1px solid ${colors.border}`,
        boxShadow: "0 6px 24px rgba(0,0,0,0.65)",
        transition: isGesturing ? "none" : "box-shadow 120ms",
      }}
      onPointerDownCapture={onFocus}
    >
      <ChartPanel
        symbol={win.symbol}
        label={win.label}
        timePeriod={win.timePeriod}
        barInterval={win.barInterval}
        onTimeframeChange={(tf) => patch({ id: win.id, patch: tf })}
        paused={win.minimized}
        headerRight={controls}
        onHeaderPointerDown={beginDrag}
        frozenBodyHeight={frozenBodyHeight}
      />

      {!win.minimized && (
        <div
          data-no-drag
          onPointerDown={beginResize}
          className="absolute bottom-0 right-0"
          style={{
            width: 14,
            height: 14,
            cursor: "nwse-resize",
            background: `linear-gradient(135deg, transparent 50%, ${colors.border} 50%, ${colors.border} 62%, transparent 62%, transparent 74%, ${colors.border} 74%, ${colors.border} 86%, transparent 86%)`,
          }}
        />
      )}
    </div>
  );
}

export const FloatingChartWindow = memo(FloatingChartWindowInner);
