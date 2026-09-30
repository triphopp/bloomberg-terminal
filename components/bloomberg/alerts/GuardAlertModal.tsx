"use client";

/**
 * Blocking alert for RED TRADE GUARD / MARGIN events (STOP_HIT, DAY_LOSS,
 * DD_STOP, margin DANGER / LIQUIDATION) — see guard-alert.ts for the split.
 *
 * Stays on screen until the user decides: ACK marks the event read (it leaves
 * the ticker too), OPEN RISK acks and jumps to PORT → RISK where the TRADE
 * GUARD card has SELL / HOLD, LATER only hides it for this session — the
 * event stays unacked in the ticker. Several events queue; the header counts.
 *
 * Mounted once in TerminalLayout. Never sends an order.
 */

import { useAtom, useSetAtom } from "jotai";
import { AlertTriangle } from "lucide-react";
import { startTransition, useCallback, useEffect, useRef } from "react";

import { currentViewAtom, portfolioTabRequestAtom } from "../atoms";
import { useAlertEvents } from "../hooks/useAlertRules";
import {
  SEVERITY_COLOR,
  fieldsOf,
  guardModalQueueAtom,
  headlineOf,
  nextStepOf,
} from "./guard-alert";

const RED = SEVERITY_COLOR.RED;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function GuardAlertModal() {
  const [queue, setQueue] = useAtom(guardModalQueueAtom);
  const setView = useSetAtom(currentViewAtom);
  const requestTab = useSetAtom(portfolioTabRequestAtom);
  const { ackEvents } = useAlertEvents({ acked: false, limit: 50 });
  const primaryRef = useRef<HTMLButtonElement>(null);

  const event = queue[0];

  const next = useCallback(() => setQueue((q) => q.slice(1)), [setQueue]);
  const ack = useCallback(() => {
    if (event) ackEvents.mutate([event.id]);
    next();
  }, [event, ackEvents, next]);
  const openRisk = useCallback(() => {
    if (event) ackEvents.mutate([event.id]);
    setQueue([]);
    startTransition(() => {
      requestTab("risk");
      setView("portfolio");
    });
  }, [event, ackEvents, setQueue, requestTab, setView]);

  useEffect(() => {
    if (event) primaryRef.current?.focus();
  }, [event]);

  if (!event) return null;

  const fields = fieldsOf(event);
  const step = nextStepOf(event);
  const isPosition = event.ruleId.startsWith("guard:") && event.symbol !== "PORT";

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 font-mono"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") next();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="guard-alert-title"
        aria-describedby="guard-alert-step"
        className="w-[380px] max-w-full border"
        style={{
          background: "var(--bb-surface-deep)",
          borderColor: "var(--bb-border-mid)",
          borderTop: `2px solid ${RED}`,
          boxShadow: `0 0 0 1px ${RED}22, 0 12px 40px rgba(0,0,0,0.8)`,
        }}
      >
        {/* Header strip */}
        <div
          className="flex items-center justify-between px-3 py-1.5 border-b"
          style={{ borderColor: "var(--bb-border)", background: `${RED}12` }}
        >
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3 animate-pulse" style={{ color: RED }} />
            <span
              className="text-[9px] font-bold tracking-[0.2em]"
              style={{ color: "var(--bb-text-sec)" }}
            >
              {event.ruleId.startsWith("margin:") ? "MARGIN" : "TRADE GUARD"}
            </span>
          </span>
          <span className="text-[9px] tabular-nums" style={{ color: "var(--bb-text-dim)" }}>
            {fmtTime(event.firedAt)}
            {queue.length > 1 && (
              <span className="ml-2 font-bold" style={{ color: RED }}>
                1/{queue.length}
              </span>
            )}
          </span>
        </div>

        {/* Headline */}
        <div className="px-3 pt-3 pb-2">
          <div
            id="guard-alert-title"
            className="text-[13px] font-bold tracking-[0.15em]"
            style={{ color: RED }}
          >
            {headlineOf(event)}
          </div>
          <div className="mt-0.5 text-[18px] font-bold" style={{ color: "var(--bb-text)" }}>
            {event.symbol}
          </div>
        </div>

        {/* Readings */}
        <div
          className="mx-3 grid border"
          style={{
            gridTemplateColumns: `repeat(${fields.length}, minmax(0, 1fr))`,
            borderColor: "var(--bb-border)",
            background: "var(--bb-bg)",
          }}
        >
          {fields.map((f, i) => (
            <div
              key={f.label}
              className="px-2 py-1.5"
              style={{ borderLeft: i ? "1px solid var(--bb-border)" : undefined }}
            >
              <div
                className="text-[8px] font-bold tracking-wider"
                style={{ color: "var(--bb-text-dim)" }}
              >
                {f.label}
              </div>
              <div
                className="text-[12px] font-bold tabular-nums"
                style={{ color: f.color ?? "var(--bb-text)" }}
              >
                {f.value}
              </div>
            </div>
          ))}
        </div>

        {step && (
          <p
            id="guard-alert-step"
            className="px-3 pt-2.5 text-[10px] leading-relaxed"
            style={{ color: "var(--bb-text-sec)" }}
          >
            {step}
          </p>
        )}

        {/* Actions — bare text per the house rule (styles/globals.css) */}
        <div
          className="mt-3 flex items-center justify-end gap-4 px-3 py-2 border-t text-[10px] font-bold tracking-wider"
          style={{ borderColor: "var(--bb-border)" }}
        >
          <button
            type="button"
            onClick={next}
            className="hover:opacity-70"
            style={{ color: "var(--bb-text-dim)" }}
            title="ซ่อนไว้ก่อน — ยังค้างใน ticker"
          >
            LATER <span className="font-normal">ESC</span>
          </button>
          <button
            type="button"
            onClick={ack}
            className="hover:opacity-70"
            style={{ color: "var(--bb-text-sec)" }}
          >
            ACK
          </button>
          <button
            ref={primaryRef}
            type="button"
            onClick={openRisk}
            className="hover:opacity-70 focus:outline-none focus-visible:underline"
            style={{ color: "var(--bb-accent)" }}
          >
            {isPosition ? "OPEN RISK → SELL / HOLD" : "OPEN RISK"} ↵
          </button>
        </div>
      </div>
    </div>
  );
}
