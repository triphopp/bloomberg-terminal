"use client";

import { useEffect, useMemo, useState } from "react";
import { PULSE_KEY, SENTIMENT_COLORS } from "./constants";
import {
  PULSE_WINDOWS,
  type PulseArticle,
  type PulseCell,
  buildPulse,
  netTone,
} from "./news-pulse";
import type { ThemeColors } from "./types";

// NEWS PULSE: the headlines the WATCHLIST tab is showing, as one row per ticker
// and one column per slice of time. Colour = tone of the headlines in the cell
// (the same word list as the list's ▲/▼), depth = how many there were. A row
// name or a cell picks that ticker, as the sector list does.

const MAX_ROWS = 14;

interface Saved {
  open: boolean;
  window: string;
}

function loadSaved(): Saved {
  const fallback = { open: true, window: "24h" };
  if (typeof window === "undefined") return fallback;
  try {
    const s = localStorage.getItem(PULSE_KEY);
    if (s) return { ...fallback, ...(JSON.parse(s) as Partial<Saved>) };
  } catch {
    /* ignore */
  }
  return fallback;
}

function cellColor(c: PulseCell, maxCell: number): string | undefined {
  if (!c.n) return undefined;
  const net = netTone(c) ?? 0;
  const base =
    net > 0.15 ? SENTIMENT_COLORS.POS : net < -0.15 ? SENTIMENT_COLORS.NEG : SENTIMENT_COLORS.NEU;
  // Depth from count: one headline is faint, the busiest cell is solid.
  const alpha = Math.round((0.3 + 0.7 * (c.n / Math.max(1, maxCell))) * 255);
  return `${base}${alpha.toString(16).padStart(2, "0")}`;
}

function agoLabel(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

export function NewsPulseGrid({
  articles,
  colors,
  selectedSymbol,
  onSymbol,
}: {
  articles: PulseArticle[];
  colors: ThemeColors;
  selectedSymbol: string | null;
  onSymbol: (symbol: string | null) => void;
}) {
  const [saved, setSaved] = useState<Saved>(loadSaved);
  useEffect(() => {
    try {
      localStorage.setItem(PULSE_KEY, JSON.stringify(saved));
    } catch {
      /* ignore */
    }
  }, [saved]);
  const win = PULSE_WINDOWS.find((w) => w.id === saved.window) ?? PULSE_WINDOWS[1];

  // The grid's right edge is "now": move it along once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const pulse = useMemo(
    () =>
      buildPulse(articles, {
        now,
        hours: win.hours,
        bucketHours: win.bucketHours,
        maxRows: MAX_ROWS,
      }),
    [articles, now, win.hours, win.bucketHours]
  );
  const cols = pulse.starts.length;

  return (
    <div className="shrink-0 border-b font-mono" style={{ borderColor: colors.border }}>
      <div className="flex items-center gap-2 px-2 py-0.5 text-[8px]">
        <button
          type="button"
          aria-pressed={saved.open}
          onClick={() => setSaved((s) => ({ ...s, open: !s.open }))}
          className="font-bold tracking-widest hover:opacity-80"
          style={{ color: colors.accent }}
          title="Who is in the news, when, and in what tone"
        >
          {saved.open ? "▾" : "▸"} NEWS PULSE
        </button>
        {saved.open &&
          PULSE_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={win.id === w.id}
              onClick={() => setSaved((s) => ({ ...s, window: w.id }))}
              className="font-bold hover:opacity-80"
              style={{ color: win.id === w.id ? colors.accent : colors.textSecondary }}
              title={`last ${w.hours} hours, ${agoLabel(w.bucketHours * 3_600_000)} per column`}
            >
              {w.label}
            </button>
          ))}
        {saved.open && (
          <span className="ml-auto flex items-center gap-2" style={{ color: colors.textSecondary }}>
            <span style={{ color: SENTIMENT_COLORS.POS }}>■ pos</span>
            <span style={{ color: SENTIMENT_COLORS.NEG }}>■ neg</span>
            <span style={{ color: SENTIMENT_COLORS.NEU }}>■ mixed / none</span>
            <span>depth = count</span>
          </span>
        )}
      </div>

      {saved.open && (
        <div className="px-2 pb-1.5">
          {pulse.rows.length === 0 ? (
            <div className="py-2 text-[8px]" style={{ color: colors.textSecondary }}>
              no headline in the last {win.hours} hours
            </div>
          ) : (
            <div
              className="grid items-center"
              style={{
                gridTemplateColumns: `52px repeat(${cols}, minmax(0, 1fr)) 44px`,
                columnGap: 1,
                rowGap: 1,
              }}
            >
              {pulse.rows.map((r) => {
                const on = selectedSymbol === r.symbol;
                const net = netTone(r);
                return (
                  <div key={r.symbol} className="contents">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onSymbol(on ? null : r.symbol)}
                      className="text-left text-[8px] font-bold truncate hover:opacity-80"
                      style={{ color: on ? colors.accent : colors.text }}
                      title={`${r.symbol}: ${r.n} headlines · ▲${r.pos} ▼${r.neg}`}
                    >
                      {r.symbol}
                    </button>
                    {r.cells.map((c, i) => {
                      const from = now - pulse.starts[i];
                      const to = from - pulse.bucketMs;
                      return (
                        <button
                          // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed time slots
                          key={i}
                          type="button"
                          onClick={() => c.n && onSymbol(r.symbol)}
                          data-frame
                          className="h-2.5"
                          style={{
                            backgroundColor: cellColor(c, pulse.maxCell) ?? "#ffffff08",
                            cursor: c.n ? "pointer" : "default",
                          }}
                          title={
                            c.n
                              ? `${r.symbol} · ${agoLabel(from)}–${to <= 0 ? "now" : `${agoLabel(to)} ago`} · ${c.n} headline${c.n > 1 ? "s" : ""} ▲${c.pos} ▼${c.neg}`
                              : undefined
                          }
                        />
                      );
                    })}
                    <span
                      className="text-right text-[7px]"
                      style={{
                        color:
                          net == null || Math.abs(net) <= 0.15
                            ? colors.textSecondary
                            : net > 0
                              ? SENTIMENT_COLORS.POS
                              : SENTIMENT_COLORS.NEG,
                      }}
                    >
                      {r.n} · {r.pos}/{r.neg}
                    </span>
                  </div>
                );
              })}
              {/* Time axis: every sixth column. */}
              <span />
              {pulse.starts.map((s, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns are fixed time slots
                  key={i}
                  className="text-[7px] whitespace-nowrap overflow-visible"
                  style={{ color: colors.textSecondary }}
                >
                  {i % 6 === 0 ? `-${agoLabel(now - s)}` : ""}
                </span>
              ))}
              <span className="text-right text-[7px]" style={{ color: colors.textSecondary }}>
                now
              </span>
            </div>
          )}
          {(pulse.hidden > 0 || pulse.outside > 0) && (
            <div className="pt-0.5 text-[7px]" style={{ color: colors.textSecondary }}>
              {pulse.hidden > 0 && `+${pulse.hidden} quieter tickers not shown · `}
              {pulse.outside > 0 && `${pulse.outside} headlines older than ${win.hours}h`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
