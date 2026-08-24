"use client";

/**
 * DetachedChartWindow — a chart running in a REAL browser window.
 *
 * An in-page popup can never leave the browser viewport, which makes a second
 * monitor useless for comparing charts. This opens an actual `window.open`
 * window and renders the same <ChartPanel> into its document through a portal,
 * so the chart is still one React tree — same atoms, same React Query cache,
 * one request per symbol — while the OS owns the window and the user can drag
 * it to any screen.
 *
 * Notes that shaped the implementation:
 *  - `window.open` needs transient user activation, so detaching is only ever
 *    triggered by a click. Nothing here reopens a window on page load — after a
 *    reload the entry comes back as an in-page popup, one click from detached
 *    again.
 *  - The child document starts empty: the parent's stylesheets are cloned into
 *    it, otherwise Tailwind classes and the terminal font resolve to nothing.
 *  - Screen coordinates are saved per symbol, so re-detaching puts the window
 *    back on the monitor it was on.
 */

import { useSetAtom } from "jotai";
import { PictureInPicture2, X } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  type ChartWindowState,
  closeChartWindowAtom,
  patchChartWindowAtom,
  rememberNativeBoundsAtom,
} from "../atoms/chart-windows";
import { bloombergColors } from "../lib/theme-config";
import { ChartPanel } from "./ChartPanel";
import type { NativeBounds } from "./window-geometry";

const colors = bloombergColors.dark;

interface Props {
  win: ChartWindowState;
  /** Where this symbol's native window was last seen, if it has been detached before. */
  bounds: NativeBounds | undefined;
}

/**
 * Copy the parent's styles into the child document.
 *
 * `<link>` tags are re-created (cloning keeps the same href, which the child
 * fetches from cache) and `<style>` tags are copied by text. Next.js injects
 * dev styles as `<style>` and production styles as `<link>`, so both matter.
 */
function cloneStyles(target: Document) {
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    target.head.appendChild(node.cloneNode(true));
  }
}

function featureString(bounds: NativeBounds | undefined): string {
  const w = bounds?.width ?? 760;
  const h = bounds?.height ?? 520;
  // `popup` is what makes Chrome treat this as a real window rather than a tab,
  // and it is also the mode in which the position features are honoured.
  const parts = [
    "popup=yes",
    `width=${w}`,
    `height=${h}`,
    "menubar=no",
    "toolbar=no",
    "location=no",
  ];
  if (bounds) parts.push(`left=${bounds.left}`, `top=${bounds.top}`);
  return parts.join(",");
}

function DetachedChartWindowInner({ win, bounds }: Props) {
  const patch = useSetAtom(patchChartWindowAtom);
  const close = useSetAtom(closeChartWindowAtom);
  const rememberBounds = useSetAtom(rememberNativeBoundsAtom);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [blocked, setBlocked] = useState(false);

  const reattach = useCallback(() => {
    patch({ id: win.id, patch: { detached: false } });
  }, [patch, win.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot per detached entry — `bounds` is only the starting position and the setters are stable; re-running would tear the user's window down mid-use
  useEffect(() => {
    // The window NAME is deliberately unique per detach. Chrome remembers the
    // geometry — including a maximized state — of a *named* popup and restores
    // it over the feature string, and a maximized window cannot be resized or
    // moved by script at all, so a reused name permanently pinned the chart to
    // whatever it was last left as. A fresh name has no remembered state, so
    // the saved bounds in the feature string are honoured.
    const child = window.open("", `chart-${win.id}`, featureString(bounds));
    if (!child) {
      setBlocked(true);
      return;
    }

    // Chrome restores its own remembered geometry for a NAMED popup and applies
    // it after the open call returns, so a single resize/move here loses the
    // race and the window comes back wherever it was last maximized. Reapply on
    // a couple of later ticks; each call is cheap and idempotent.
    const restoreTimers: number[] = [];
    if (bounds) {
      const applyBounds = () => {
        if (child.closed) return;
        if (child.outerWidth === bounds.width && child.outerHeight === bounds.height) return;
        try {
          child.resizeTo(bounds.width, bounds.height);
          child.moveTo(bounds.left, bounds.top);
        } catch {
          /* blocked by the browser — the window is still usable where it landed */
        }
      };
      applyBounds();
      // Chrome can open the popup MAXIMIZED (it carries that state over from the
      // last popup), and a maximized window ignores resizeTo entirely until it
      // has settled. Retrying over the first second and a half is what actually
      // lands it; each attempt no-ops once the size matches.
      for (const delay of [60, 300, 800, 1500]) {
        restoreTimers.push(window.setTimeout(applyBounds, delay));
      }
    }

    child.document.title = `${win.symbol} — chart`;
    cloneStyles(child.document);
    child.document.body.style.margin = "0";
    child.document.body.style.background = "#050505";
    child.document.body.style.overflow = "hidden";

    const mount = child.document.createElement("div");
    mount.style.height = "100vh";
    mount.style.width = "100vw";
    child.document.body.appendChild(mount);
    setContainer(mount);

    // Snapshot the OS geometry while the window still exists. `beforeunload`
    // fires for both the user closing it and this component tearing it down.
    const saveBounds = () => {
      if (child.closed) return;
      rememberBounds({
        symbol: win.symbol,
        bounds: {
          left: child.screenX,
          top: child.screenY,
          width: child.outerWidth,
          height: child.outerHeight,
        },
      });
    };

    // Closing the window is the user saying "put this chart away", so it also
    // closes the entry rather than leaving an invisible one in the list.
    const onChildUnload = () => {
      saveBounds();
      close(win.id);
    };
    child.addEventListener("beforeunload", onChildUnload);

    // A window closed from the OS chrome does not always deliver beforeunload
    // to the opener (it does not survive a crash either), so poll as a backstop.
    const poll = window.setInterval(() => {
      if (child.closed) close(win.id);
    }, 1000);

    // Track moves/resizes cheaply — the child fires `resize`, and a move is only
    // observable by sampling, so sample on the same slow timer. Started after
    // the restore window so it cannot record the pre-restore position.
    const boundsTimer = window.setInterval(saveBounds, 2000);

    // If the terminal tab goes away, take the detached window with it: an
    // orphaned window has no React tree behind it and would freeze mid-render.
    const onParentUnload = () => child.close();
    window.addEventListener("beforeunload", onParentUnload);

    return () => {
      for (const t of restoreTimers) window.clearTimeout(t);
      window.clearInterval(poll);
      window.clearInterval(boundsTimer);
      window.removeEventListener("beforeunload", onParentUnload);
      child.removeEventListener("beforeunload", onChildUnload);
      saveBounds();
      setContainer(null);
      child.close();
    };
  }, [win.id, win.symbol]);

  if (blocked) {
    // Portalled and fixed: this component renders outside the docked-window
    // layer, so an absolutely positioned notice would land wherever the page
    // happens to scroll to.
    return createPortal(
      <div
        className="fixed px-2 py-1 text-[10px] font-mono"
        style={{
          left: 8,
          bottom: 92,
          background: "#0d0d0d",
          border: `1px solid ${colors.negative}`,
          color: colors.text,
          zIndex: 70,
        }}
      >
        {win.symbol}: browser blocked the pop-out window. Allow pop-ups for this site, then
        <button
          type="button"
          className="ml-1 underline"
          style={{ color: colors.accent }}
          onClick={reattach}
        >
          bring it back
        </button>
      </div>,
      document.body
    );
  }

  if (!container) return null;

  return createPortal(
    <div className="h-full w-full">
      <ChartPanel
        symbol={win.symbol}
        label={win.label}
        timePeriod={win.timePeriod}
        barInterval={win.barInterval}
        onTimeframeChange={(tf) => patch({ id: win.id, patch: tf })}
        headerRight={
          <>
            <button
              type="button"
              aria-label="Dock chart back into the terminal"
              title="Dock back into the terminal"
              className="px-0.5"
              style={{ color: colors.textSecondary }}
              onClick={reattach}
            >
              <PictureInPicture2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label="Close chart window"
              className="px-0.5"
              style={{ color: colors.textSecondary }}
              onClick={() => close(win.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </>
        }
      />
    </div>,
    container
  );
}

export const DetachedChartWindow = memo(DetachedChartWindowInner);
