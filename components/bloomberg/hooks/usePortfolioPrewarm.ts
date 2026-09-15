"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { prewarmPortfolio } from "../views/portfolio/queries";

/**
 * Warm the PORT caches in the background, once per terminal session.
 *
 * Opening PORT cold costs seconds of waiting: positions, then `premarket`
 * (~4s) which cannot start until the symbol list is back.
 * None of that depends on the user being in the view, so it runs while the
 * terminal sits idle on MKT — by the time P is pressed the React Query cache
 * (and the backend's own TTL caches) already hold the answers and the table
 * paints filled in.
 *
 * Deliberately late and idle-gated: the market view's own requests come first,
 * and a session where PORT is never opened pays only for requests the backend
 * caches anyway.
 */

const DELAY_MS = 4000;

export function usePortfolioPrewarm() {
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let idleHandle: number | undefined;

    const run = () => {
      if (cancelled) return;
      void prewarmPortfolio(qc);
    };

    const timer = setTimeout(() => {
      if (typeof requestIdleCallback !== "undefined") {
        idleHandle = requestIdleCallback(run, { timeout: 10_000 });
      } else {
        run();
      }
    }, DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (idleHandle !== undefined && typeof cancelIdleCallback !== "undefined") {
        cancelIdleCallback(idleHandle);
      }
    };
  }, [qc]);
}
