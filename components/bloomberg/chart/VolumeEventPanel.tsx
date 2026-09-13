"use client";

/**
 * VolumeEventPanel — the classified volume events as a list, beside the chips
 * the overlay draws on the price pane (volume-event-overlay.ts).
 *
 * The chart answers "where"; this answers "what, how strong, and what happened
 * next". The forward-return columns are the point of the panel rather than a
 * decoration: a label is only worth reading if its outcomes separate from the
 * symbol's unconditional behaviour, and the way to find that out is to have the
 * numbers in front of you. They are descriptive — a handful of events on one
 * chart is not a study, and the header says so.
 *
 * It classifies the same bars the overlay does, with the same defaults, so the
 * two agree without anything being passed between them.
 */

import { useMemo } from "react";
import {
  EVENT_CODE,
  EVENT_DOC,
  EVENT_NAME,
  type EventBar,
  classifyVolumeEvents,
  forwardReturnPct,
} from "../lib/volume-events.ts";
import type { ChartColors } from "./types";
import { EVENT_COLOR } from "./volume-event-overlay.ts";

/** Horizons shown as columns, in bars. */
const HORIZONS = [1, 5];

export interface VolumeEventPanelProps {
  data: EventBar[];
  colors: ChartColors;
  /** Max height of the scrollable row area, in px. */
  height?: number;
}

function fmtDate(time: string | number): string {
  if (typeof time === "number") {
    const d = new Date(time * 1000);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  return time.slice(2); // "2026-03-05" → "26-03-05"
}

function fmtPct(v: number | null): string {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
}

export function VolumeEventPanel({ data, colors, height = 104 }: VolumeEventPanelProps) {
  const events = useMemo(() => classifyVolumeEvents(data), [data]);
  // Newest first: the event worth acting on is almost always the last one.
  const rows = useMemo(() => [...events].reverse(), [events]);

  return (
    <div className="flex flex-col" style={{ borderTop: `1px solid ${colors.border}` }}>
      <div
        className="shrink-0 flex items-center justify-between px-1 py-0.5 text-[8px] font-bold font-mono"
        style={{ color: colors.textSecondary }}
      >
        <span>
          VOLUME EVENTS<span style={{ color: colors.text }}> {events.length}</span>
        </span>
        <span title="Forward returns describe these bars only — they are not a backtest and not a forecast">
          FWD = close-to-close, descriptive
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="px-1 py-1 text-[9px] font-mono" style={{ color: colors.textSecondary }}>
          No volume events in this range — a wider period, or a symbol that reports volume, will
          populate this.
        </div>
      ) : (
        <div className="overflow-y-auto font-mono text-[9px]" style={{ maxHeight: height }}>
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ color: colors.textSecondary }}>
                <th className="text-left font-normal px-1">DATE</th>
                <th className="text-left font-normal px-1">EVENT</th>
                <th className="text-right font-normal px-1" title="Robust log-volume z-score">
                  Z
                </th>
                <th className="text-right font-normal px-1" title="The event bar's own return">
                  RET
                </th>
                {HORIZONS.map((h) => (
                  <th
                    key={h}
                    className="text-right font-normal px-1"
                    title={`Close ${h} bar${h > 1 ? "s" : ""} later vs the event bar's close`}
                  >
                    +{h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const color = EVENT_COLOR[e.type];
                return (
                  <tr key={`${e.index}-${e.type}`} style={{ borderTop: "1px solid #141414" }}>
                    <td className="px-1 whitespace-nowrap" style={{ color: colors.textSecondary }}>
                      {fmtDate(e.time)}
                    </td>
                    <td className="px-1 whitespace-nowrap">
                      <span
                        className="font-bold"
                        style={{ color }}
                        title={`${EVENT_NAME[e.type]} — ${EVENT_DOC[e.type]}`}
                      >
                        {EVENT_CODE[e.type]}
                      </span>
                      {/* Direction is which side owned the bar, never a call. */}
                      <span style={{ color: colors.textSecondary }}>
                        {e.dir === 1 ? " ▲" : e.dir === -1 ? " ▼" : "  "}
                        {e.runLength ? ` ×${e.runLength}` : ""}
                      </span>
                    </td>
                    <td className="px-1 text-right" style={{ color }}>
                      {e.z >= 0 ? "+" : ""}
                      {e.z.toFixed(1)}
                    </td>
                    <td
                      className="px-1 text-right"
                      style={{ color: e.retPct >= 0 ? colors.positive : colors.negative }}
                    >
                      {fmtPct(e.retPct)}
                    </td>
                    {HORIZONS.map((h) => {
                      const fwd = forwardReturnPct(data, e.index, h);
                      return (
                        <td
                          key={h}
                          className="px-1 text-right"
                          style={{
                            color:
                              fwd == null
                                ? colors.textSecondary
                                : fwd >= 0
                                  ? colors.positive
                                  : colors.negative,
                          }}
                        >
                          {fmtPct(fwd)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
