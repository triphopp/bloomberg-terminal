"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_WINDOW_H, MIN_WINDOW_W, TITLE_BAR_H, clampWindow } from "./window-geometry";

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface UseWindowDragOptions {
  /** Committed geometry from the store. Used whenever no gesture is running. */
  geometry: WindowGeometry;
  /** Called once per gesture, on pointerup — not on every move. */
  onCommit: (geo: WindowGeometry) => void;
  /** Called on pointerdown anywhere on the window, to raise it. */
  onFocus?: () => void;
  /** Skip the resize gesture (a minimized window has no body to resize). */
  resizable?: boolean;
}

type Gesture =
  | null
  | { kind: "drag"; pointerId: number; offsetX: number; offsetY: number }
  | {
      kind: "resize";
      pointerId: number;
      startX: number;
      startY: number;
      startW: number;
      startH: number;
    };

/**
 * Pointer-driven drag + resize for a floating window.
 *
 * Writes go to local state during the gesture and to `onCommit` once on release,
 * so a drag doesn't push a localStorage write per mousemove. Listeners live on
 * `window` rather than the element, so the gesture survives the cursor
 * outrunning the box or crossing an iframe-free overlay.
 *
 * The stored geometry is the user's INTENT and is never rewritten to fit the
 * viewport. Fitting happens at render time only. An earlier version committed
 * the clamped value on mount and on every browser resize, which quietly
 * rewrote the saved layout — dragging the browser to a second monitor, or any
 * resize while a window sat near an edge, permanently "reset" that window's
 * position.
 */
export function useWindowDrag({
  geometry,
  onCommit,
  onFocus,
  resizable = true,
}: UseWindowDragOptions) {
  const [live, setLive] = useState<WindowGeometry | null>(null);
  const gestureRef = useRef<Gesture>(null);
  // Read inside the window-level listeners without re-subscribing them.
  const liveRef = useRef<WindowGeometry>(geometry);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  // `geometry` is a fresh object on every render of the caller, so effects and
  // callbacks below read it through this ref instead — otherwise every quote
  // refresh would tear down and re-add the window-level listeners.
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  // Re-render (not re-store) when the viewport changes, so the clamped render
  // position below follows the window without touching what is persisted.
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined"
      ? { width: 1280, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight }
  );
  useEffect(() => {
    const onResize = () =>
      setViewport((prev) =>
        prev.width === window.innerWidth && prev.height === window.innerHeight
          ? prev
          : { width: window.innerWidth, height: window.innerHeight }
      );
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const beginDrag = useCallback(
    (e: React.PointerEvent) => {
      // Ignore anything but the primary button — right-click opens menus, and a
      // middle-click drag would leave the window stuck to the cursor.
      if (e.button !== 0) return;
      onFocus?.();
      const target = e.target as HTMLElement;
      // Buttons inside the title bar (close, minimize, chart type) must stay
      // clickable rather than starting a drag.
      if (target.closest("[data-no-drag]")) return;
      e.preventDefault();
      const geo = geometryRef.current;
      gestureRef.current = {
        kind: "drag",
        pointerId: e.pointerId,
        offsetX: e.clientX - geo.x,
        offsetY: e.clientY - geo.y,
      };
      liveRef.current = geo;
      setLive(geo);
    },
    [onFocus]
  );

  const beginResize = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !resizable) return;
      onFocus?.();
      e.preventDefault();
      e.stopPropagation();
      const geo = geometryRef.current;
      gestureRef.current = {
        kind: "resize",
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startW: geo.w,
        startH: geo.h,
      };
      liveRef.current = geo;
      setLive(geo);
    },
    [onFocus, resizable]
  );

  const gesturing = live !== null;

  // Armed by `gesturing`, not by `live`: the listeners read geometry off refs,
  // so a moving pointer must never resubscribe them.
  useEffect(() => {
    if (!gesturing) return;

    const onMove = (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (!g || ev.pointerId !== g.pointerId) return;
      const vp = { width: window.innerWidth, height: window.innerHeight };
      let next: WindowGeometry;
      if (g.kind === "drag") {
        next = clampWindow(
          {
            x: ev.clientX - g.offsetX,
            y: ev.clientY - g.offsetY,
            w: liveRef.current.w,
            h: liveRef.current.h,
          },
          vp
        );
      } else {
        const w = Math.max(MIN_WINDOW_W, g.startW + (ev.clientX - g.startX));
        const h = Math.max(MIN_WINDOW_H, g.startH + (ev.clientY - g.startY));
        next = clampWindow({ x: liveRef.current.x, y: liveRef.current.y, w, h }, vp);
      }
      liveRef.current = next;
      setLive(next);
    };

    const onUp = (ev: PointerEvent) => {
      const g = gestureRef.current;
      if (g && ev.pointerId !== g.pointerId) return;
      gestureRef.current = null;
      commitRef.current(liveRef.current);
      setLive(null);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = gestureRef.current?.kind === "resize" ? "nwse-resize" : "move";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [gesturing]);

  // Live geometry is already clamped by the gesture; stored geometry is clamped
  // here, for display only.
  const current = live ?? clampWindow(geometry, viewport);

  return {
    /** Geometry to render with — live during a gesture, committed otherwise. */
    x: current.x,
    y: current.y,
    w: current.w,
    h: current.h,
    isGesturing: gesturing,
    /**
     * True only while the box is being resized. The chart inside is expensive to
     * rebuild (it tears down and recreates the whole lightweight-charts
     * instance on every height change), so the caller freezes it at its
     * committed size until the gesture ends.
     */
    isResizing: gesturing && gestureRef.current?.kind === "resize",
    beginDrag,
    beginResize,
    titleBarHeight: TITLE_BAR_H,
  };
}
