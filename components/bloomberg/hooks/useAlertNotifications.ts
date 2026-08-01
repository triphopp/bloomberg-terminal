"use client";

/**
 * useAlertNotifications — client-side delivery for the alert engine's
 * `notify` channels (plan §3, backend/alerts/notify.py).
 *
 * The backend owns exactly one channel (`webhook`); the other three are
 * rendering decisions that only the browser can make, so they live here:
 *
 *   toast   → sonner popup, once per event
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

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
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

  const announce = useCallback((event: AlertEvent) => {
    const title = `${event.symbol} · ${ruleDisplayName(event.ruleName, event.symbol)}`;
    if (event.notify.includes("toast")) {
      toast(title, { description: describe(event) });
    }
    if (event.notify.includes("sound")) {
      playBeep();
    }
  }, []);

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
    for (const event of [...fresh].sort((a, b) => a.id - b.id)) {
      announce(event);
    }

    announcedRef.current = maxId;
    writeWatermark(maxId);
  }, [events, announce]);

  return {
    tickerEvents: events.filter((e) => e.notify.includes("ticker")),
    ackEvents,
  };
}
