"use client";

/**
 * FooterGauges — Fear & Greed · VIX · MOVE in the spare middle of the MKT chart
 * footer, in the same dress as the O/H/L/C stats at its right end: label, value,
 * then ▲/▼ and the % change from the previous close.
 *
 * Colour follows what the move means for risk, not its sign: a rising VIX or
 * MOVE is stress (red), a rising Fear & Greed is appetite (green). The arrow
 * always gives the direction.
 *
 * VIX / MOVE read the ["volatility"] query the TICK DATA board already owns
 * (same key, so no extra request and the live stream's patches land here too).
 */

import { useQuery } from "@tanstack/react-query";
import { memo } from "react";
import type { MarketItem } from "../types";

interface GaugeColors {
  text: string;
  textSecondary: string;
  positive: string;
  negative: string;
}

interface FearGreedNow {
  value?: number;
  label?: string;
  previous_close?: number | null;
  source?: string;
}

/** Same bands as backend/routers/fear_greed.py `_zone_from_value`. */
function zoneLabel(v: number): string {
  if (v < 25) return "EXTREME FEAR";
  if (v < 45) return "FEAR";
  if (v < 55) return "NEUTRAL";
  if (v < 75) return "GREED";
  return "EXTREME GREED";
}

function pctChange(now: number, prev: number | null | undefined): number | null {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  return ((now - prev) / Math.abs(prev)) * 100;
}

function Gauge({
  label,
  value,
  pct,
  riskUp,
  title,
  colors,
}: {
  label: string;
  value: number | null;
  pct: number | null;
  /** True when a rise is bad news (VIX, MOVE) — flips the colour, not the arrow. */
  riskUp: boolean;
  title?: string;
  colors: GaugeColors;
}) {
  if (value == null || !Number.isFinite(value)) {
    return (
      <span title={title}>
        {label}:<span style={{ color: colors.text }}>—</span>
      </span>
    );
  }
  const up = pct != null && pct >= 0;
  const good = riskUp ? !up : up;
  return (
    <span title={title}>
      {label}:<span style={{ color: colors.text }}>{value.toFixed(2)}</span>
      {pct != null && (
        <span style={{ color: good ? colors.positive : colors.negative }}>
          {" "}
          {up ? "▲" : "▼"}
          {Math.abs(pct).toFixed(2)}%
        </span>
      )}
    </span>
  );
}

function FooterGaugesImpl({ colors }: { colors: GaugeColors }) {
  const { data: vol } = useQuery<{ items?: MarketItem[] }>({
    queryKey: ["volatility"],
    queryFn: () => fetch("/api/volatility").then((r) => r.json()),
    staleTime: 55_000,
  });
  const { data: fg } = useQuery<FearGreedNow>({
    queryKey: ["fear-greed-current"],
    queryFn: () => fetch("/api/fear-greed").then((r) => r.json()),
    staleTime: 4 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const items = vol?.items ?? [];
  const vix = items.find((i) => i.symbol === "^VIX");
  const move = items.find((i) => i.symbol === "^MOVE");
  const fgValue = typeof fg?.value === "number" ? fg.value : null;

  return (
    <div
      // One line high and wrapping: a gauge that does not fit drops to a second
      // line the box clips, so the footer shows whole gauges, never half of one.
      className="flex-1 min-w-0 h-[14px] flex flex-wrap content-start justify-center gap-x-3 whitespace-nowrap overflow-hidden"
      style={{ color: colors.textSecondary }}
    >
      <Gauge
        label="F&G"
        value={fgValue}
        pct={fgValue != null ? pctChange(fgValue, fg?.previous_close) : null}
        riskUp={false}
        title={
          fgValue != null
            ? `Fear & Greed ${zoneLabel(fgValue)} · prev close ${fg?.previous_close?.toFixed(1) ?? "—"} · ${fg?.source ?? ""}`
            : "Fear & Greed"
        }
        colors={colors}
      />
      <Gauge
        label="VIX"
        value={vix?.value ?? null}
        pct={vix?.pctChange ?? null}
        riskUp
        title="CBOE VIX · % vs previous close"
        colors={colors}
      />
      <Gauge
        label="MOVE"
        value={move?.value ?? null}
        pct={move?.pctChange ?? null}
        riskUp
        title="ICE BofA MOVE (bond volatility) · % vs previous close"
        colors={colors}
      />
    </div>
  );
}

export const FooterGauges = memo(FooterGaugesImpl);
