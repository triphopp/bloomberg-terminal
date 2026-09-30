"use client";
import { useMemo, useState } from "react";
import type { Colors } from "../helpers";

export interface DayPnl {
  date: string; // YYYY-MM-DD (close date)
  pnl: number;
  cnt: number;
  wins: number;
}

const CELL = 12;
const GAP = 2;
const DOW = ["", "Mon", "", "Wed", "", "Fri", ""];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const iso = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** GitHub-style contribution grid of realized P&L per close day.
 * Colour = sign, opacity = |pnl| / p95(|pnl|) so one outlier day can't wash out the rest. */
export function DailyPnlHeatmap({
  data,
  colors,
  money,
}: {
  data: DayPnl[];
  colors: Colors;
  money: (v: number, signed?: boolean) => string;
}) {
  const years = useMemo(
    () => [...new Set(data.map((d) => d.date.slice(0, 4)))].sort().reverse(),
    [data]
  );
  const [year, setYear] = useState<string | null>(null);
  const y = year && years.includes(year) ? year : (years[0] ?? String(new Date().getFullYear()));

  const model = useMemo(() => {
    const byDate = new Map(data.filter((d) => d.date.startsWith(y)).map((d) => [d.date, d]));
    const abs = [...byDate.values()].map((d) => Math.abs(d.pnl)).sort((a, b) => a - b);
    const p95 = abs.length ? abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))] || 1 : 1;
    const start = new Date(Date.UTC(Number(y), 0, 1));
    start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back to Sunday
    const weeks: (DayPnl | { date: string; empty: true } | null)[][] = [];
    const monthLabels: { col: number; label: string }[] = [];
    const cur = new Date(start);
    for (let w = 0; w < 54; w++) {
      const col: (DayPnl | { date: string; empty: true } | null)[] = [];
      for (let dow = 0; dow < 7; dow++) {
        const key = iso(cur);
        if (key.startsWith(y)) {
          col.push(byDate.get(key) ?? { date: key, empty: true });
          if (cur.getUTCDate() === 1)
            monthLabels.push({ col: w, label: MONTHS[cur.getUTCMonth()] });
        } else col.push(null);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      if (col.some(Boolean)) weeks.push(col);
    }
    const days = [...byDate.values()];
    const total = days.reduce((a, d) => a + d.pnl, 0);
    const wins = days.reduce((a, d) => a + d.wins, 0);
    const cnt = days.reduce((a, d) => a + d.cnt, 0);
    return {
      weeks,
      monthLabels,
      p95,
      total,
      trades: cnt,
      wins,
      greenDays: days.filter((d) => d.pnl > 0).length,
      redDays: days.filter((d) => d.pnl < 0).length,
    };
  }, [data, y]);

  return (
    <div className="font-mono text-[9px]" style={{ color: colors.textSecondary }}>
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        {years.map((yr) => (
          <button
            type="button"
            key={yr}
            onClick={() => setYear(yr)}
            aria-pressed={yr === y}
            className="text-[8px] font-bold"
            style={{ color: yr === y ? colors.accent : "#666" }}
          >
            {yr}
          </button>
        ))}
        <span className="ml-auto">
          {model.greenDays}▲ / {model.redDays}▼ days · {model.wins}W/{model.trades - model.wins}L (
          {model.trades ? Math.round((model.wins / model.trades) * 100) : 0}%) ·{" "}
          <span style={{ color: model.total >= 0 ? "#22c55e" : "#ef4444" }}>
            {money(model.total, true)}
          </span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex" style={{ gap: GAP }}>
          <div className="flex flex-col" style={{ gap: GAP, paddingTop: 12, marginRight: 2 }}>
            {DOW.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed 7 rows
              <div key={i} style={{ height: CELL, lineHeight: `${CELL}px`, fontSize: 8 }}>
                {l}
              </div>
            ))}
          </div>
          {model.weeks.map((col, ci) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed week order
            <div key={ci} className="flex flex-col" style={{ gap: GAP }}>
              <div style={{ height: 10, fontSize: 8, whiteSpace: "nowrap", overflow: "visible" }}>
                {model.monthLabels.find((m) => m.col === ci)?.label ?? ""}
              </div>
              {col.map((c, ri) => {
                const k = c ? c.date : `pad-${ci}-${ri}`;
                if (!c) return <div key={k} style={{ width: CELL, height: CELL }} />;
                if ("empty" in c)
                  return (
                    <div
                      key={k}
                      title={c.date}
                      style={{
                        width: CELL,
                        height: CELL,
                        borderRadius: 2,
                        background: "rgba(128,128,128,0.12)",
                      }}
                    />
                  );
                const a = 0.25 + 0.75 * Math.min(1, Math.abs(c.pnl) / model.p95);
                const base = c.pnl > 0 ? "34,197,94" : c.pnl < 0 ? "239,68,68" : "128,128,128";
                return (
                  <div
                    key={k}
                    title={`${c.date}\nP&L ${money(c.pnl, true)}\n${c.wins}W / ${c.cnt - c.wins}L (${c.cnt} closed)`}
                    style={{
                      width: CELL,
                      height: CELL,
                      borderRadius: 2,
                      background: `rgba(${base},${c.pnl === 0 ? 0.4 : a})`,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1 mt-1.5 justify-end" style={{ fontSize: 8 }}>
        loss
        {[1, 0.6, 0.3].map((o) => (
          <span
            key={`r${o}`}
            style={{ width: 9, height: 9, borderRadius: 2, background: `rgba(239,68,68,${o})` }}
          />
        ))}
        <span
          style={{ width: 9, height: 9, borderRadius: 2, background: "rgba(128,128,128,0.12)" }}
        />
        {[0.3, 0.6, 1].map((o) => (
          <span
            key={`g${o}`}
            style={{ width: 9, height: 9, borderRadius: 2, background: `rgba(34,197,94,${o})` }}
          />
        ))}
        profit · hover a day for P&L and W/L
      </div>
    </div>
  );
}
