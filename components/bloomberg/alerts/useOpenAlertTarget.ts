"use client";

import { useCallback } from "react";

import type { RiskSubTabRequest } from "../atoms";
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

/** The page an alert is acted on: PORT → RISK for TRADE GUARD / MARGIN, the
 *  thesis (or the calendar day) for a CALENDAR reminder. */
export type AlertTarget =
  | { kind: "risk"; sub: RiskSubTabRequest }
  | { kind: "tools"; req: CalendarTarget };

/** null = an ordinary rule alert, which has no page of its own. */
export function alertTargetOf(
  e: Pick<AlertEvent, "ruleId" | "snapshot" | "barTime">
): AlertTarget | null {
  const risk = riskTargetOf(e);
  if (risk) return { kind: "risk", sub: risk };
  if (isCalendarEvent(e)) return { kind: "tools", req: calendarTargetOf(e) };
  return null;
}

export function alertLinkLabel(t: AlertTarget): string {
  return t.kind === "risk" ? riskLinkLabel(t.sub) : calendarLinkLabel(t.req);
}

/** One opener for every alert surface — ticker chip, alert list, toast. */
export function useOpenAlertTarget() {
  const openRisk = useOpenRisk();
  const openCalendarTarget = useOpenCalendarTarget();
  return useCallback(
    (t: AlertTarget) => (t.kind === "risk" ? openRisk(t.sub) : openCalendarTarget(t.req)),
    [openRisk, openCalendarTarget]
  );
}
