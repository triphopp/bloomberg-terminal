"use client";

/**
 * useAlertNotifications — client-side delivery for the alert engine's
 * `notify` channels (plan §3, backend/alerts/notify.py).
 *
 * The backend owns exactly one channel (`webhook`); the other three are
 * rendering decisions that only the browser can make, so they live here:
 *
 *   toast   → sonner popup, once per event — except RED TRADE GUARD /
 *             MARGIN events (stop hit, day-loss cap, liquidation), which go
 *             to <GuardAlertModal/> and stay until acknowledged. A CALENDAR
 *             reminder's toast carries the way to the thesis it belongs to
 *   sound   → short WebAudio beep, no asset to ship or fail to load
 *   ticker  → handed to <AlertTicker/> to render inline (see `tickerEvents`)
 *
 * The hard part isn't playing a sound, it's **not** replaying history. The
 * events feed is a poll over everything that ever fired, so a naive "toast
 * whatever the query returns" fires the whole backlog on every mount and
 * again on every refetch. Two guards:
 *
 *   1. A high-water mark of the largest event id already announced, kept in
 *      localStorage so a page reload doesn't re-announce.
 *   2. On the very first run with no stored mark, adopt the current maximum
 *      silently — opening the app for the first time should not detonate
 *      three weeks of alerts at once.
 *
 * Both mean announcements are per-device, which is the right scope: the
 * events table is deliberately device-local and doesn't cloud-sync (plan
 * §11.5).
 */

import { useSetAtom } from "jotai";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { calendarLinkLabel, calendarToasts, isCalendarEvent } from "../alerts/calendar-alert";
import {
  SEVERITY_COLOR,
  describeGuard,
  guardModalQueueAtom,
  headlineOf,
  isGuardEvent,
  isModalEvent,
  riskLinkLabel,
  riskTargetOf,
  severityOf,
} from "../alerts/guard-alert";
import { useOpenDepth } from "../alerts/useOpenAlertTarget";
import { useOpenRisk } from "../alerts/useOpenRisk";
import { useOpenCalendarTarget } from "../alerts/useOpenTools";
import { describeWebull, isWebullEvent, webullHeadline } from "../alerts/webull-alert";
import { type AlertEvent, ruleDisplayName, useAlertEvents } from "./useAlertRules";

const WATERMARK_KEY = "bt.alerts.lastAnnouncedEventId";

function readWatermark(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(WATERMARK_KEY);
  if (raw == null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function writeWatermark(id: number) {
  try {
    window.localStorage.setItem(WATERMARK_KEY, String(id));
  } catch {
    // Private mode / quota — degrade to per-session dedupe via the ref.
  }
}

/** Short two-tone blip. Synthesized so there's no audio asset to 404. */
function playBeep() {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    // Browsers suspend audio until a user gesture. Rather than nag, stay
    // silent this time — the toast still lands.
    if (ctx.state === "suspended") {
      void ctx.close();
      return;
    }
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1320, now + 0.12);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.3);
    osc.onended = () => void ctx.close();
  } catch {
    // Audio is a nicety; never let it break the render.
  }
}

function describe(event: AlertEvent): string {
  const values = Object.entries(event.snapshot)
    .filter(([key]) => !key.startsWith("const:"))
    .map(([, v]) => (typeof v === "number" ? v.toFixed(2) : "n/a"));
  const tail = values.length ? ` · ${values.join(" / ")}` : "";
  return `bar ${event.barTime}${tail}`;
}

export interface UseAlertNotificationsResult {
  /** Unacked events whose rule asked for the ticker, newest first. */
  tickerEvents: AlertEvent[];
  ackEvents: ReturnType<typeof useAlertEvents>["ackEvents"];
}

export function useAlertNotifications(): UseAlertNotificationsResult {
  const { events, ackEvents } = useAlertEvents({ acked: false, limit: 50 });
  // Mirrors the localStorage mark. Also covers the window between a toast
  // firing and the write landing, and keeps working when storage is blocked.
  const announcedRef = useRef<number | null>(null);

  const enqueueModal = useSetAtom(guardModalQueueAtom);
  const openRisk = useOpenRisk();
  const openCalendarTarget = useOpenCalendarTarget();
  const openDepth = useOpenDepth();

  const announce = useCallback(
    (event: AlertEvent) => {
      if (event.notify.includes("toast")) {
        if (isModalEvent(event)) {
          enqueueModal((q) => (q.some((e) => e.id === event.id) ? q : [...q, event]));
        } else if (isGuardEvent(event)) {
          // The left rule carries the severity (see .bb-toast in globals.css).
          // The action is the way to the page where the event is acted on —
          // a rebalance alert lands on PORT → RISK → REBALANCE, not the summary.
          const target = riskTargetOf(event) ?? "summary";
          toast(`${event.symbol} · ${headlineOf(event)}`, {
            description: describeGuard(event),
            style: { "--bb-toast-rule": SEVERITY_COLOR[severityOf(event)] } as CSSProperties,
            action: { label: `${riskLinkLabel(target)} →`, onClick: () => openRisk(target) },
          });
        } else if (isWebullEvent(event)) {
          // What ended, and the way to where it is put right.
          toast(`${event.symbol} · ${webullHeadline(event)}`, {
            description: describeWebull(event),
            style: { "--bb-toast-rule": "#FF9800" } as CSSProperties,
            action: { label: "OPEN DEPTH →", onClick: openDepth },
          });
        } else {
          toast(`${event.symbol} · ${ruleDisplayName(event.ruleName, event.symbol)}`, {
            description: describe(event),
          });
        }
      }
      if (event.notify.includes("sound")) {
        playBeep();
      }
    },
    [enqueueModal, openRisk, openDepth]
  );

  useEffect(() => {
    if (!events.length) return;

    const maxId = events.reduce((m, e) => Math.max(m, e.id), 0);
    if (announcedRef.current == null) {
      announcedRef.current = readWatermark();
    }

    // First ever run on this device: adopt the backlog silently.
    if (announcedRef.current == null) {
      announcedRef.current = maxId;
      writeWatermark(maxId);
      return;
    }

    const mark = announcedRef.current;
    const fresh = events.filter((e) => e.id > mark);
    if (!fresh.length) return;

    // Oldest first, so a burst reads in the order it happened.
    const ordered = [...fresh].sort((a, b) => a.id - b.id);
    // CALENDAR reminders are a date coming up, not a breach: one toast per
    // thesis for the batch, and the action is the thesis the dates belong to.
    const isReminder = (e: AlertEvent) => isCalendarEvent(e) && e.notify.includes("toast");
    for (const event of ordered) {
      if (!isReminder(event)) announce(event);
    }
    for (const t of calendarToasts(ordered.filter(isReminder))) {
      toast(t.title, {
        description: t.description,
        style: { "--bb-toast-rule": "#4ade80" } as CSSProperties,
        action: {
          label: `${calendarLinkLabel(t.target)} →`,
          onClick: () => openCalendarTarget(t.target),
        },
      });
    }

    announcedRef.current = maxId;
    writeWatermark(maxId);
  }, [events, announce, openCalendarTarget]);

  return {
    tickerEvents: events.filter((e) => e.notify.includes("ticker")),
    ackEvents,
  };
}
