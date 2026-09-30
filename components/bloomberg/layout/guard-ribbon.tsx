"use client";

/**
 * TRADE GUARD light in the shared status row, visible from every view.
 * Click → PORT → RISK, where the TRADE GUARD card says what to do.
 * Same query as the card for ALL accounts in THB, so the two share a cache.
 * Backend: GET /api/v2/portfolio/risk/guard (backend/trade_guard.py).
 */

import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { startTransition } from "react";

import { currentViewAtom, portfolioTabRequestAtom } from "../atoms";

type Light = "GREEN" | "YELLOW" | "RED";

interface GuardSummary {
  light: Light;
  actions: { level: "RED" | "YELLOW" | "INFO"; code: string; text: string }[];
  counts: Record<string, number>;
  size_multiplier: number;
  /** Notifier heartbeat (backend/guard_scheduler.py status()). */
  scan?: { state: "OK" | "STARTING" | "ERROR" | "STALE" | "OFF"; last_error: string | null };
}

const LIGHT_COLOR: Record<Light, string> = {
  GREEN: "#00C853",
  YELLOW: "#FFB300",
  RED: "#FF4444",
};

export function GuardRibbon() {
  const setView = useSetAtom(currentViewAtom);
  const requestTab = useSetAtom(portfolioTabRequestAtom);

  const { data, isError } = useQuery<GuardSummary>({
    queryKey: ["risk-guard", "all", "THB"],
    queryFn: async () => {
      const r = await fetch("/api/v2/portfolio/risk/guard?base_currency=THB");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const live = (data?.actions ?? []).filter((a) => a.level !== "INFO");
  const stops = data?.counts.STOP_HIT ?? 0;
  const near = data?.counts.NEAR_STOP ?? 0;
  const summary = [
    stops ? `${stops} STOP` : "",
    near ? `${near} NEAR` : "",
    data && data.size_multiplier !== 1 ? `SIZE ×${data.size_multiplier}` : "",
    data && !stops && !near && live.length ? `${live.length} CHECK` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      className="flex h-full shrink-0 items-center gap-1.5 border-r border-[#242424] px-2 font-mono select-none"
      title={
        data ? live.map((a) => a.text).join("\n") || "TRADE GUARD: ไม่มีอะไรต้องทำ" : "TRADE GUARD"
      }
      aria-label={`TRADE GUARD ${data?.light ?? "loading"} — open PORT RISK`}
      onClick={() => {
        // Transition: the view swap (unmount current view, mount PORT → RISK)
        // renders off the click, so the next paint isn't held behind it (INP).
        startTransition(() => {
          requestTab("risk");
          setView("portfolio");
        });
      }}
    >
      <span className="font-bold tracking-wide" style={{ color: "#888", fontSize: 9 }}>
        GUARD
      </span>
      <span
        className="font-bold"
        style={{ color: data ? LIGHT_COLOR[data.light] : "#555", fontSize: 9 }}
      >
        ● {isError ? "NO DATA" : (data?.light ?? "…")}
      </span>
      {summary && (
        <span className="text-[8.5px]" style={{ color: data ? LIGHT_COLOR[data.light] : "#555" }}>
          {summary}
        </span>
      )}
      {/* The light is computed live; the notifier behind the alerts is not —
          say so when it is not running, or a quiet ticker reads as "all clear". */}
      {data?.scan &&
        (data.scan.state === "STALE" ||
          data.scan.state === "OFF" ||
          data.scan.state === "ERROR") && (
          <span
            className="text-[8.5px] font-bold"
            style={{ color: data.scan.state === "ERROR" ? "#FFB300" : "#FF4444" }}
            title={data.scan.last_error ?? "ตัวเตือน TRADE GUARD ไม่ได้สแกน — ไม่มีเตือน STOP HIT"}
          >
            ALERTS {data.scan.state}
          </span>
        )}
    </button>
  );
}
