"use client";

import { useEffect } from "react";

/**
 * Flashes every number on the page when its value changes: green when it went
 * up, red when it went down.
 *
 * Without it a refreshed quote that moved by one tick looks exactly like a
 * quote that never refreshed, and there is no way to tell a live screen from a
 * frozen one. It is one observer on <body> rather than a hook in every panel,
 * so a panel added later gets it for free and none of them can forget it.
 *
 * What counts as a number: an element whose whole text is a figure — optional
 * sign, currency, thousands separators, decimals, a %/bp/K/M/B suffix, an
 * ▲/▼ tail. Clocks (09:30), dates (2026-09-26), labels ("Cost ฿1.2M") and
 * countdowns do not match, so they never flash.
 *
 * Direction comes from the element's full text, not from the text node that
 * changed: `-฿1,234` is three React text nodes, and the digits alone would read
 * a deepening loss as a rise.
 *
 * Opt out with `data-noflash` on any ancestor.
 */

const NUM_RE = /^\(?[+\-−]?[฿$€£¥]?[+\-−]?\d[\d,]*(\.\d+)?\s*(%|bps?|[KMBT]|x)?\)?\s*[▲▼]?$/;

const UP = "#22ff88";
const DOWN = "#ff4d6a";

/** A change arriving this soon after a click or key press is the user's own
 *  doing (tab switch, THB↔USD, sort), not a tick. */
const USER_QUIET_MS = 400;

function parse(text: string): number | null {
  const t = text.trim();
  if (!t || t.length > 32 || !NUM_RE.test(t)) return null;
  const neg = /^\(?[฿$€£¥]?[\-−]/.test(t) || t.endsWith("▼");
  const digits = t.replace(/[^\d.]/g, "");
  const n = Number.parseFloat(digits);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** `el`'s own text (direct text children only — a nested "(+1.26%)" span is
 *  its own figure). With `oldValues`, each mutated node reads as it was
 *  before this batch. */
function ownText(el: Element, oldValues?: Map<Node, string>): string {
  let s = "";
  for (const child of el.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE) continue;
    s += oldValues?.has(child) ? oldValues.get(child) : child.nodeValue;
  }
  return s;
}

function flash(el: Element, up: boolean) {
  const c = up ? UP : DOWN;
  // Colour + glow, not a background: the global text-only rule forces span
  // backgrounds transparent with !important, which beats an animation.
  el.animate([{ color: c, textShadow: `0 0 6px ${c}` }], {
    duration: 900,
    easing: "ease-out",
  });
}

export function TickFlash() {
  useEffect(() => {
    if (typeof MutationObserver === "undefined" || !document.body.animate) return;

    let lastUserInput = 0;
    const markInput = () => {
      lastUserInput = performance.now();
    };
    window.addEventListener("pointerdown", markInput, true);
    window.addEventListener("keydown", markInput, true);

    const observer = new MutationObserver((records) => {
      if (document.hidden) return;
      if (performance.now() - lastUserInput < USER_QUIET_MS) return;

      // Group by the element that owns the changed text, remembering each text
      // node's value from BEFORE the batch.
      const oldValues = new Map<Node, string>();
      const parents = new Set<Element>();
      for (const r of records) {
        if (r.type === "characterData") {
          if (!oldValues.has(r.target)) oldValues.set(r.target, r.oldValue ?? "");
          if (r.target.parentElement) parents.add(r.target.parentElement);
        } else if (
          r.type === "childList" &&
          r.addedNodes.length === 1 &&
          r.removedNodes.length === 1 &&
          r.addedNodes[0].nodeType === Node.TEXT_NODE &&
          r.removedNodes[0].nodeType === Node.TEXT_NODE &&
          r.target instanceof Element
        ) {
          // textContent replaced wholesale: the element held only this text.
          oldValues.set(r.addedNodes[0], r.removedNodes[0].nodeValue ?? "");
          parents.add(r.target);
        }
      }

      for (const el of parents) {
        if (!el.isConnected || el.closest("[data-noflash],input,textarea,[contenteditable]")) {
          continue;
        }
        let before = parse(ownText(el, oldValues));
        let after = parse(ownText(el));
        if (before == null || after == null) {
          // Element carries a label as well; fall back to the lone text node.
          const node = [...el.childNodes].find((n) => oldValues.has(n));
          if (!node) continue;
          before = parse(oldValues.get(node) ?? "");
          after = parse(node.nodeValue ?? "");
        }
        if (before == null || after == null || before === after) continue;
        // A ×10 jump is a unit/currency switch landing late, not a tick.
        if (before !== 0 && after !== 0) {
          const ratio = Math.abs(after / before);
          if (ratio > 10 || ratio < 0.1) continue;
        }
        flash(el, after > before);
      }
    });

    observer.observe(document.body, {
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
      childList: true,
    });

    return () => {
      observer.disconnect();
      window.removeEventListener("pointerdown", markInput, true);
      window.removeEventListener("keydown", markInput, true);
    };
  }, []);

  return null;
}
