"use client";

import { useSetAtom } from "jotai";
import { startTransition, useCallback } from "react";

import { type RiskSubTabRequest, currentViewAtom, structureModeRequestAtom } from "../atoms";
import type { AlertEvent } from "../hooks/useAlertRules";
import {
  type CalendarTarget,
  calendarLinkLabel,
  calendarTargetOf,
  isCalendarEvent,
} from "./calendar-alert";
import { riskLinkLabel, riskTargetOf } from "./guard-alert";
import { useOpenRisk } from "./useOpenRisk";
import { useOpenCalendarTarget } from "./useOpenTools";
import { isWebullEvent } from "./webull-alert";

/** The page an alert is acted on: PORT → RISK for TRADE GUARD / MARGIN, the
 *  thesis (or the calendar day) for a CALENDAR reminder, MKT → STRUCTURE →
 *  DEPTH for a WEBULL notice (where a token is requested). */
export type AlertTarget =
  | { kind: "risk"; sub: RiskSubTabRequest }
  | { kind: "tools"; req: CalendarTarget }
  | { kind: "depth" };

/** null = an ordinary rule alert, which has no page of its own. */
export function alertTargetOf(
  e: Pick<AlertEvent, "ruleId" | "snapshot" | "barTime">
): AlertTarget | null {
  const risk = riskTargetOf(e);
  if (risk) return { kind: "risk", sub: risk };
  if (isCalendarEvent(e)) return { kind: "tools", req: calendarTargetOf(e) };
  if (isWebullEvent(e)) return { kind: "depth" };
  return null;
}

export function alertLinkLabel(t: AlertTarget): string {
  if (t.kind === "depth") return "OPEN DEPTH";
  return t.kind === "risk" ? riskLinkLabel(t.sub) : calendarLinkLabel(t.req);
}

/** MKT with the STRUCTURE panel on DEPTH. A transition, like useOpenRisk. */
export function useOpenDepth() {
  const setView = useSetAtom(currentViewAtom);
  const requestMode = useSetAtom(structureModeRequestAtom);
  return useCallback(() => {
    startTransition(() => {
      requestMode("depth");
      setView("market");
    });
  }, [setView, requestMode]);
}

/** One opener for every alert surface — ticker chip, alert list, toast. */
export function useOpenAlertTarget() {
  const openRisk = useOpenRisk();
  const openCalendarTarget = useOpenCalendarTarget();
  const openDepth = useOpenDepth();
  return useCallback(
    (t: AlertTarget) => {
      if (t.kind === "depth") openDepth();
      else if (t.kind === "risk") openRisk(t.sub);
      else openCalendarTarget(t.req);
    },
    [openRisk, openCalendarTarget, openDepth]
  );
}
