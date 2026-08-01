"use client";

/**
 * WatchlistAlertsBadge — global "you have alerts" indicator for the
 * WATCHLIST header, distinct from the per-symbol bell in AlertBellCell and
 * from pinned-assets.tsx's own `totalAlerts` (that one's a price-target
 * hit, unrelated to the rule engine in backend/alerts/).
 *
 * Two states, not two components:
 *   unread > 0  → bright/pulsing, count = unread — hard to miss
 *   unread = 0  → reverts to the header's normal muted tone, count = total
 *                 events in the fetched window — still informative, no
 *                 longer shouting
 * "Read" here means acked via the dropdown, same alert_events.acked column
 * AlertBellCell already uses — there's one read state, not a second one
 * invented for this badge.
 */

import { Bell, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ruleDisplayName, useAlertEvents } from "../hooks/useAlertRules";
import type { bloombergColors } from "../lib/theme-config";

const ALERT_CYAN = "#33DDFF";

export function WatchlistAlertsBadge({ colors }: { colors: typeof bloombergColors.dark }) {
  const { events, ackEvents } = useAlertEvents({ limit: 50 });
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (events.length === 0) return null;

  const unread = events.filter((e) => !e.acked);
  const hasUnread = unread.length > 0;

  const markAllRead = () => {
    const ids = unread.map((e) => e.id);
    if (!ids.length) return;
    ackEvents.mutate(ids, {
      onError: (err) => toast.error(`Couldn't mark alerts read: ${(err as Error).message}`),
    });
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`text-[9px] px-1.5 py-0 font-bold flex items-center gap-1 border ${hasUnread ? "animate-pulse" : ""}`}
        style={
          hasUnread
            ? { background: "#00384430", color: ALERT_CYAN, borderColor: `${ALERT_CYAN}66` }
            : { background: "transparent", color: colors.textSecondary, borderColor: colors.border }
        }
        title={
          hasUnread
            ? `${unread.length} unread alert${unread.length === 1 ? "" : "s"}`
            : `${events.length} alert${events.length === 1 ? "" : "s"} — all read`
        }
      >
        <Bell className="h-2.5 w-2.5" fill={hasUnread ? ALERT_CYAN : "none"} />
        {hasUnread ? unread.length : events.length}
      </button>

      {open && (
        <div
          className="absolute z-50 top-full left-0 mt-1 w-[280px] border text-[9px] font-mono"
          style={{
            background: colors.surface,
            borderColor: colors.border,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          <div
            className="flex items-center justify-between px-2 py-1 border-b sticky top-0"
            style={{ borderColor: colors.border, background: colors.surface }}
          >
            <span className="uppercase tracking-widest" style={{ color: colors.textSecondary }}>
              Alerts
            </span>
            {hasUnread && (
              <button
                type="button"
                onClick={markAllRead}
                disabled={ackEvents.isPending}
                className="flex items-center gap-1 opacity-80 hover:opacity-100 disabled:opacity-40"
                style={{ color: ALERT_CYAN }}
              >
                <Check className="h-2.5 w-2.5" />
                Mark all read
              </button>
            )}
          </div>
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-start justify-between gap-2 px-2 py-1 border-b last:border-b-0"
              style={{ borderColor: `${colors.border}66` }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {!e.acked && (
                    <span
                      className="h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ background: ALERT_CYAN }}
                    />
                  )}
                  <span className="font-bold truncate" style={{ color: colors.text }}>
                    {e.symbol}
                  </span>
                  <span className="opacity-60 truncate" style={{ color: colors.textSecondary }}>
                    {ruleDisplayName(e.ruleName, e.symbol)}
                  </span>
                </div>
                <span className="opacity-50" style={{ color: colors.textSecondary }}>
                  bar {e.barTime}
                </span>
              </div>
              {!e.acked && (
                <button
                  type="button"
                  onClick={() =>
                    ackEvents.mutate([e.id], {
                      onError: (err) =>
                        toast.error(`Couldn't mark alert read: ${(err as Error).message}`),
                    })
                  }
                  className="shrink-0 opacity-50 hover:opacity-100"
                  title="Mark read"
                  style={{ color: colors.textSecondary }}
                >
                  <Check className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
