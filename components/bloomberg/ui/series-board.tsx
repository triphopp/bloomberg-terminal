"use client";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/** One indicator series and the slice of history the board asked for. */
export interface SeriesRow {
  id: string;
  group_key: string;
  section: string;
  label: string;
  unit: string;
  source: string;
  source_url: string;
  freq: string;
  tags: string;
  last_value: number | null;
  last_date: string | null;
  /** The publisher's own change for the latest print. */
  change_pct: number | null;
  /** Change across the window this board requested. */
  window_change_pct: number | null;
  point_count: number;
  stale_days: number | null;
  captured_at: string | null;
  points: { date: string; value: number | null; high: number | null; low: number | null }[];
}

export interface SeriesBoardColors {
  text: string;
  textSecondary: string;
  accent: string;
  border: string;
  background?: string;
}

const API = "/api/v2/series";

/** A board of indicator series — deliberately knows nothing about what it shows.
 *
 *  Everything on screen comes from the payload: the sections, the labels, the
 *  units, the source stamp. That is the whole point — the first board is memory
 *  spot prices, and the second one (freight, survey indices, whatever gets a
 *  collector) renders through this same component without touching it.
 *
 *  The one opinion it holds is about honesty: these series are accumulated a day
 *  at a time from publishers that do not sell their history, so a chart may be
 *  three points long. The row says how many points exist rather than drawing a
 *  confident line through them, and a series whose source date has gone stale
 *  says so instead of showing a number as if it were today's. */
export function SeriesBoard({
  group,
  colors,
  days = 60,
}: {
  group: string;
  colors: SeriesBoardColors;
  days?: number;
}) {
  const [rows, setRows] = useState<SeriesRow[]>([]);
  const [sections, setSections] = useState<string[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const r = await fetch(`${API}?group=${encodeURIComponent(group)}&days=${days}`, {
          signal,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.detail ?? "load failed");
        setRows(Array.isArray(d.series) ? d.series : []);
        setSections(Array.isArray(d.sections) ? d.sections : []);
        setAsOf(d.as_of ?? null);
        setError(null);
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setError("โหลดข้อมูลไม่สำเร็จ — backend ตอบไหม?");
      } finally {
        setLoading(false);
      }
    },
    [group, days]
  );

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch(`${API}/refresh`, { method: "POST" });
      const d = await r.json();
      const failed = (d?.results ?? []).filter((x: { ok: boolean }) => !x.ok);
      setError(
        failed.length
          ? `ดึงไม่สำเร็จ: ${failed.map((f: { source: string; error: string }) => `${f.source} — ${f.error}`).join(" · ")}`
          : null
      );
      await load();
    } catch {
      setError("เรียก refresh ไม่สำเร็จ");
    } finally {
      setRefreshing(false);
    }
  };

  const bySection = useMemo(() => {
    const map = new Map<string, SeriesRow[]>();
    for (const s of sections.length ? sections : [""]) map.set(s, []);
    for (const r of rows) {
      const key = r.section || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(r);
    }
    return map;
  }, [rows, sections]);

  const current = rows.find((r) => r.id === selected) ?? null;
  const sources = useMemo(() => [...new Set(rows.map((r) => r.source))], [rows]);

  if (loading) {
    return (
      <div
        className="flex-1 flex items-center justify-center gap-2 text-[10px]"
        style={{ color: colors.textSecondary }}
      >
        <Loader2 className="h-3 w-3 animate-spin" /> กำลังโหลด…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div
        className="flex-1 overflow-y-auto p-4 text-[10px]"
        style={{ color: colors.textSecondary }}
      >
        <div className="font-bold mb-2" style={{ color: colors.accent }}>
          ยังไม่มีข้อมูลในกลุ่ม "{group}"
        </div>
        <p className="mb-2">กด REFRESH เพื่อดึงครั้งแรก — ตัวเก็บข้อมูลจะบันทึกค่าของวันนี้ไว้</p>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="px-2 py-0.5 border text-[9px] font-bold disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          {refreshing ? "กำลังดึง…" : "REFRESH"}
        </button>
        {error && (
          <div className="mt-2" style={{ color: "#f87171" }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* board */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div
          className="shrink-0 flex items-center gap-2 px-2 py-1 border-b text-[9px]"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          <span style={{ color: colors.accent }} className="font-bold tracking-widest">
            {group.toUpperCase()}
          </span>
          <span>{rows.length} series</span>
          <span>latest {asOf ?? "—"}</span>
          <span>source {sources.join(", ") || "—"}</span>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            title="ดึงข้อมูลจากแหล่งทันที"
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 border font-bold disabled:opacity-40"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            <RefreshCw className={`h-2.5 w-2.5 ${refreshing ? "animate-spin" : ""}`} />
            REFRESH
          </button>
        </div>

        {error && (
          <div className="shrink-0 px-2 py-1 text-[9px]" style={{ color: "#f87171" }}>
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {[...bySection.entries()].map(([section, list]) =>
            list.length === 0 ? null : (
              <div key={section || "_"}>
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [section]: !c[section] }))}
                  className="w-full text-left px-2 py-0.5 text-[9px] font-bold tracking-widest border-b sticky top-0 z-10"
                  style={{
                    color: colors.accent,
                    borderColor: colors.border,
                    background: colors.background ?? "#000",
                  }}
                >
                  {collapsed[section] ? "▸" : "▾"} {section || "SERIES"} ({list.length})
                </button>
                {/* Fixed columns: each section is its own table, so without
                    them the value column lands at a different x in every
                    section and the board stops scanning as one page. */}
                {!collapsed[section] && (
                  <table className="w-full text-[10px] font-mono table-fixed">
                    <colgroup>
                      <col />
                      <col width="96" />
                      <col width="36" />
                      <col width="72" />
                      <col width="100" />
                      <col width="104" />
                    </colgroup>
                    <tbody>
                      {list.map((r) => (
                        <SeriesLine
                          key={r.id}
                          row={r}
                          colors={colors}
                          selected={selected === r.id}
                          onSelect={() => setSelected(r.id === selected ? null : r.id)}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          )}
        </div>
      </div>
      {current && (
        <SeriesDetail id={current.id} colors={colors} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ── row ──────────────────────────────────────────────────────────────────────

function SeriesLine({
  row,
  colors,
  selected,
  onSelect,
}: {
  row: SeriesRow;
  colors: SeriesBoardColors;
  selected: boolean;
  onSelect: () => void;
}) {
  const values = row.points.map((p) => p.value).filter((v): v is number => v != null);
  const chg = row.change_pct;
  return (
    <tr
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      tabIndex={0}
      aria-selected={selected}
      className="cursor-pointer"
      style={{
        borderBottom: `1px solid ${colors.border}`,
        background: selected ? "#ff990012" : "transparent",
      }}
    >
      <td
        className="px-2 py-0.5 truncate"
        style={{ color: selected ? colors.accent : colors.text }}
      >
        {row.label}
      </td>
      <td className="px-1 py-0.5 text-right tabular-nums" style={{ color: colors.text }}>
        {row.last_value == null ? "—" : fmt(row.last_value)}
      </td>
      <td className="px-1 py-0.5 text-[8px]" style={{ color: colors.textSecondary }}>
        {row.unit}
      </td>
      <td
        className="px-1 py-0.5 text-right tabular-nums"
        style={{
          color:
            chg == null
              ? colors.textSecondary
              : chg > 0
                ? "#4ade80"
                : chg < 0
                  ? "#f87171"
                  : colors.textSecondary,
        }}
      >
        {chg == null ? "—" : `${chg > 0 ? "+" : ""}${chg.toFixed(2)}%`}
      </td>
      <td className="px-1 py-0.5 w-[92px]">
        {values.length >= 2 ? (
          <Spark values={values} color={colors.accent} />
        ) : (
          <span className="text-[8px]" style={{ color: colors.textSecondary }}>
            {row.point_count} pt
          </span>
        )}
      </td>
      <td className="px-2 py-0.5 text-right text-[8px]" style={{ color: colors.textSecondary }}>
        {row.last_date ?? "—"}
        {row.stale_days != null && row.stale_days > staleLimit(row.freq) && (
          <span title={`ยังไม่อัปเดตมา ${row.stale_days} วัน`} style={{ color: "#facc15" }}>
            {" "}
            ⚠{row.stale_days}d
          </span>
        )}
      </td>
    </tr>
  );
}

/** How old a print may get before it is worth flagging.
 *
 *  A weekly table legitimately shows a ten-day-old date, so one threshold for
 *  everything would either cry wolf on those or never fire on a daily series
 *  whose parser has quietly broken. */
function staleLimit(freq: string): number {
  if (freq === "contract") return 45;
  if (freq === "weekly") return 12;
  return 4;
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

// ── charts ───────────────────────────────────────────────────────────────────

/** Inline SVG so it inherits the terminal's colours and needs no canvas sizing. */
function Spark({ values, color }: { values: number[]; color: string }) {
  const w = 88;
  const h = 16;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / Math.max(1, values.length - 1);
  const d = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 2) - 1).toFixed(1)}`
    )
    .join(" ");
  const rising = values[values.length - 1] >= values[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={rising ? "#4ade80" : "#f87171"} strokeWidth="1" />
      <circle
        cx={w}
        cy={h - ((values[values.length - 1] - min) / span) * (h - 2) - 1}
        r="1.4"
        fill={color}
      />
    </svg>
  );
}

function SeriesDetail({
  id,
  colors,
  onClose,
}: {
  id: string;
  colors: SeriesBoardColors;
  onClose: () => void;
}) {
  const [data, setData] = useState<SeriesRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(365);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    fetch(`${API}/${encodeURIComponent(id)}?days=${range}`, { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d ?? null))
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [id, range]);

  const pts = (data?.points ?? []).filter((p) => p.value != null);

  return (
    <div
      className="w-[340px] shrink-0 border-l flex flex-col overflow-hidden"
      style={{ borderColor: colors.border }}
    >
      <div
        className="shrink-0 flex items-center gap-1 px-2 py-1 border-b"
        style={{ borderColor: colors.border }}
      >
        <span className="text-[9px] font-bold truncate" style={{ color: colors.accent }}>
          {data?.label ?? id}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[9px] px-1"
          style={{ color: colors.textSecondary }}
        >
          ✕
        </button>
      </div>

      <div
        className="shrink-0 flex gap-1 px-2 py-1 text-[8px]"
        style={{ color: colors.textSecondary }}
      >
        {[30, 90, 365, 3650].map((d) => (
          <button
            type="button"
            key={d}
            onClick={() => setRange(d)}
            className="px-1 border"
            style={{
              borderColor: range === d ? colors.accent : colors.border,
              color: range === d ? colors.accent : colors.textSecondary,
            }}
          >
            {d >= 3650 ? "ALL" : `${d}D`}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="px-2 py-2">
            {pts.length >= 2 ? (
              <LineChart points={pts} colors={colors} />
            ) : (
              <div className="text-[9px] leading-relaxed" style={{ color: colors.textSecondary }}>
                มี {pts.length} จุดที่บันทึกไว้ — แหล่งข้อมูลไม่เปิดประวัติย้อนหลัง (กราฟของเขาเป็นของสมาชิก)
                เส้นกราฟจะยาวขึ้นเองวันละจุด
              </div>
            )}
          </div>

          <div
            className="px-2 pb-2 text-[8px] leading-relaxed"
            style={{ color: colors.textSecondary }}
          >
            <div>
              หน่วย {data?.unit || "—"} · ความถี่ {data?.freq || "—"}
            </div>
            <div>
              บันทึกแล้ว {data?.point_count ?? 0} จุด · ล่าสุด {data?.last_date ?? "—"}
            </div>
            <div className="truncate">
              แหล่ง {data?.source}
              {data?.source_url ? (
                <>
                  {" · "}
                  <a
                    href={data.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    style={{ color: colors.accent }}
                  >
                    เปิดหน้าต้นทาง
                  </a>
                </>
              ) : null}
            </div>
            <div>อ่านเมื่อ {(data?.captured_at ?? "").slice(0, 16).replace("T", " ")} UTC</div>
          </div>

          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr style={{ color: colors.textSecondary }}>
                {["DATE", "VALUE", "HIGH", "LOW"].map((h) => (
                  <th key={h} className="px-2 py-0.5 text-right first:text-left font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...pts].reverse().map((p) => (
                <tr key={p.date} style={{ borderTop: `1px solid ${colors.border}` }}>
                  <td className="px-2 py-0.5" style={{ color: colors.textSecondary }}>
                    {p.date}
                  </td>
                  <td
                    className="px-2 py-0.5 text-right tabular-nums"
                    style={{ color: colors.text }}
                  >
                    {p.value == null ? "—" : fmt(p.value)}
                  </td>
                  <td
                    className="px-2 py-0.5 text-right tabular-nums"
                    style={{ color: colors.textSecondary }}
                  >
                    {p.high == null ? "—" : fmt(p.high)}
                  </td>
                  <td
                    className="px-2 py-0.5 text-right tabular-nums"
                    style={{ color: colors.textSecondary }}
                  >
                    {p.low == null ? "—" : fmt(p.low)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Line with the publisher's high/low band behind it, when the source has one. */
function LineChart({
  points,
  colors,
}: {
  points: { date: string; value: number | null; high: number | null; low: number | null }[];
  colors: SeriesBoardColors;
}) {
  const w = 300;
  const h = 130;
  const pad = { l: 34, r: 4, t: 6, b: 14 };
  const vals = points.flatMap((p) =>
    [p.value, p.high, p.low].filter((v): v is number => v != null)
  );
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i * (w - pad.l - pad.r)) / Math.max(1, points.length - 1);
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (h - pad.t - pad.b);

  const line = points
    .map((p, i) =>
      p.value == null ? "" : `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`
    )
    .join(" ");

  const hasBand = points.some((p) => p.high != null && p.low != null);
  const band = hasBand
    ? [
        ...points.map(
          (p, i) =>
            `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.high ?? p.value ?? min).toFixed(1)}`
        ),
        ...[...points].reverse().map((p, i) => {
          const idx = points.length - 1 - i;
          return `L${x(idx).toFixed(1)},${y(p.low ?? p.value ?? min).toFixed(1)}`;
        }),
        "Z",
      ].join(" ")
    : "";

  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="series history">
      <title>series history</title>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={pad.l}
            x2={w - pad.r}
            y1={pad.t + f * (h - pad.t - pad.b)}
            y2={pad.t + f * (h - pad.t - pad.b)}
            stroke={colors.border}
            strokeWidth="0.5"
          />
          <text
            x={pad.l - 3}
            y={pad.t + f * (h - pad.t - pad.b) + 3}
            textAnchor="end"
            fontSize="7"
            fill={colors.textSecondary}
          >
            {fmt(max - f * span)}
          </text>
        </g>
      ))}
      {hasBand && <path d={band} fill={colors.accent} opacity="0.12" />}
      <path d={line} fill="none" stroke={colors.accent} strokeWidth="1.2" />
      <text x={pad.l} y={h - 3} fontSize="7" fill={colors.textSecondary}>
        {points[0]?.date}
      </text>
      <text x={w - pad.r} y={h - 3} fontSize="7" textAnchor="end" fill={colors.textSecondary}>
        {points[points.length - 1]?.date}
      </text>
    </svg>
  );
}
