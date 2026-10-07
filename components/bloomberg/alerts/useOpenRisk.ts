"use client";

import { useSetAtom } from "jotai";
import { startTransition, useCallback } from "react";

import {
  type RiskSubTabRequest,
  currentViewAtom,
  portfolioTabRequestAtom,
  riskSubTabRequestAtom,
} from "../atoms";

/**
 * Jump to PORT → RISK, optionally straight to one of its pages — the link
 * behind a TRADE GUARD / MARGIN alert (toast, ticker chip, alert list).
 * A transition: the view swap renders off the click, not inside it.
 */
export function useOpenRisk() {
  const setView = useSetAtom(currentViewAtom);
  const requestTab = useSetAtom(portfolioTabRequestAtom);
  const requestSub = useSetAtom(riskSubTabRequestAtom);
  return useCallback(
    (sub: RiskSubTabRequest = "summary") => {
      startTransition(() => {
        requestSub(sub);
        requestTab("risk");
        setView("portfolio");
      });
    },
    [setView, requestTab, requestSub]
  );
}
