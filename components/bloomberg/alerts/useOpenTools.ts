"use client";

import { useSetAtom } from "jotai";
import { startTransition, useCallback } from "react";

import {
  type ToolsRequest,
  calendarRequestAtom,
  currentViewAtom,
  portfolioTabRequestAtom,
  toolsRequestAtom,
} from "../atoms";
import type { CalendarTarget } from "./calendar-alert";

/**
 * Jump to a place in PORT → TOOLS from anywhere — the link behind a calendar
 * date and a CALENDAR alert (ticker chip, toast, alert list): the thesis the
 * date belongs to, or a question.
 * A transition, like useOpenRisk: the view swap renders off the click.
 */
export function useOpenTools() {
  const setView = useSetAtom(currentViewAtom);
  const requestTab = useSetAtom(portfolioTabRequestAtom);
  const requestTools = useSetAtom(toolsRequestAtom);
  return useCallback(
    (req: ToolsRequest) => {
      startTransition(() => {
        requestTools(req);
        requestTab("tools");
        setView("portfolio");
      });
    },
    [setView, requestTab, requestTools]
  );
}

/** Open the CAL view, on a day when one is given (TAIL's event strip, an alert
 *  no thesis claims). */
export function useOpenCalendar() {
  const setView = useSetAtom(currentViewAtom);
  const request = useSetAtom(calendarRequestAtom);
  return useCallback(
    (at: { date?: string; category?: string } = {}) => {
      startTransition(() => {
        request(at);
        setView("calendar");
      });
    },
    [setView, request]
  );
}

/** Where a CALENDAR reminder leads (calendarTargetOf): a place in TOOLS, or
 *  that day of the calendar. */
export function useOpenCalendarTarget() {
  const openTools = useOpenTools();
  const openCalendar = useOpenCalendar();
  return useCallback(
    (t: CalendarTarget) => (t.sub === "calendar" ? openCalendar({ date: t.date }) : openTools(t)),
    [openTools, openCalendar]
  );
}
