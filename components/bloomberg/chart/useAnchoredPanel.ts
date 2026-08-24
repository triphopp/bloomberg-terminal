"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Open/close state plus fixed-viewport coordinates for a dropdown panel.
 *
 * The toolbar rows clip their overflow so they can never grow a second line,
 * which would also clip an absolutely-positioned panel inside them. Positioning
 * the panel `fixed` against the trigger's measured rect escapes that clip —
 * fixed elements are laid out against the viewport, not the scroll ancestor.
 *
 * Lives here rather than in market-view because the chart toolbar it was
 * written for is now shared by the MKT panel and every chart window.
 */
export function useAnchoredPanel() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 2 });
  }, []);

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v) place();
      return !v;
    });
  }, [place]);

  useEffect(() => {
    if (!open) return;
    // The listeners go on the trigger's OWN document: in a detached chart
    // window the panel lives in a different document, where `document` here
    // would be the terminal tab's and never see the click that should close it.
    const doc = wrapRef.current?.ownerDocument ?? document;
    const view = doc.defaultView ?? window;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Re-measure rather than close: clicking the trigger can itself scroll an
    // ancestor (the browser scrolls a partly-hidden button into view), and
    // closing on that would shut the panel the same tick it opened.
    doc.addEventListener("mousedown", onDown);
    view.addEventListener("resize", place);
    view.addEventListener("scroll", place, true);
    return () => {
      doc.removeEventListener("mousedown", onDown);
      view.removeEventListener("resize", place);
      view.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return { open, setOpen, toggle, pos, wrapRef, triggerRef };
}
