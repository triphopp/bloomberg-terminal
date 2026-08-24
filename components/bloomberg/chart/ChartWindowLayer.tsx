"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  MAX_CHART_WINDOWS,
  chartWindowNativeBoundsAtom,
  chartWindowsAtom,
  closeAllChartWindowsAtom,
  dockAllChartWindowsAtom,
} from "../atoms/chart-windows";
import { bloombergColors } from "../lib/theme-config";
import { DetachedChartWindow } from "./DetachedChartWindow";
import { FloatingChartWindow } from "./FloatingChartWindow";

const colors = bloombergColors.dark;

/**
 * Renders every chart window — docked ones as in-page boxes, detached ones as
 * real browser windows.
 *
 * Mounted once at the terminal root and portalled to <body>, so the docked
 * windows are outside every view's `overflow-hidden` container and survive view
 * switches. The layer itself is click-through (`pointer-events-none`); each
 * window opts back in.
 */
export function ChartWindowLayer() {
  const windows = useAtomValue(chartWindowsAtom);
  const nativeBounds = useAtomValue(chartWindowNativeBoundsAtom);
  const closeAll = useSetAtom(closeAllChartWindowsAtom);
  const dockAll = useSetAtom(dockAllChartWindowsAtom);
  // Portals need a DOM target, which does not exist during SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Native windows do not survive a reload of the terminal tab, and reopening
  // one needs a user gesture — so anything marked detached from a previous
  // session comes back docked.
  useEffect(() => {
    dockAll();
  }, [dockAll]);

  if (!mounted || windows.length === 0) return null;

  const detached = windows.filter((w) => w.detached);
  const docked = windows.filter((w) => !w.detached);

  return (
    <>
      {detached.map((win) => (
        <DetachedChartWindow key={win.id} win={win} bounds={nativeBounds[win.symbol]} />
      ))}

      {createPortal(
        <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 60 }}>
          {docked.map((win) => (
            <FloatingChartWindow key={win.id} win={win} />
          ))}

          {/* Manager strip — window count + a single escape hatch when the desk
              gets buried. Sits bottom-left, clear of the alert ticker. */}
          <div
            className="absolute pointer-events-auto flex items-center gap-1 px-1.5 py-0.5"
            style={{
              left: 8,
              bottom: 56,
              background: "#0d0d0d",
              border: `1px solid ${colors.border}`,
              zIndex: 1,
            }}
          >
            <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
              CHARTS {windows.length}/{MAX_CHART_WINDOWS}
              {detached.length > 0 ? ` · ${detached.length} OUT` : ""}
            </span>
            <button
              type="button"
              className="text-[9px] font-mono font-bold px-1 border"
              style={{ borderColor: colors.border, color: colors.negative }}
              onClick={() => closeAll()}
            >
              CLOSE ALL
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
