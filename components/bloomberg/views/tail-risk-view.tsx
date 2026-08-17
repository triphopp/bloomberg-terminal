"use client";

/**
 * TAIL — Risk Monitor v2.
 *
 * Reads /api/tail-risk/signals, which reports six risk *dimensions* rather than
 * a flat list of signals. The point of the grouping is diagnostic: knowing that
 * three VIX signals are lit tells you far less than knowing whether the stress
 * is confined to equity vol or has also reached credit, cross-asset vol and
 * correlation.
 *
 * Signals are tri-state. `unknown` means the data behind it could not be
 * verified and is rendered as such — never as a quiet "—" that reads like calm.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

type SignalState = "on" | "off" | "unknown";
type DimensionStatus = "ALERT" | "WATCH" | "NORMAL" | "UNKNOWN";
type RiskLevel = "HIGH" | "ELEVATED" | "CAUTION" | "NORMAL";

interface SignalStats {
  prec_is: number | null;
  rec_is: number | null;
  fires_is: number | null;
  fires_oos: number | null;
  prec_oos: number | null;
  prec_fwd: number | null;
  edge_fwd_pp: number | null;
  note: string | null;
}

interface Signal {
  id: string;
  label: string;
  dimension: string;
  rule: string;
  why: string;
  state: SignalState;
  active: boolean | null;
  value: number | string | null;
  detail: string | null;
  reason: string | null;
  validated: boolean;
  verdict: string;
  stats: SignalStats | null;
}

interface Dimension {
  id: string;
  label: string;
  question: string;
  status: DimensionStatus;
  on_count: number;
  total: number;
  unknown_count: number;
  degraded: boolean;
  active_signals: string[];
  unknown_signals: string[];
}

interface VolRow {
  name: string;
  description: string;
  value: number | null;
  change_1d: number | null;
  z63: number | null;
  pctile_1y: number | null;
  ok: boolean;
  last_date: string | null;
  source: string | null;
  reason: string | null;
}

interface HistoryItem {
  date: string;
  signals_on: number;
  alert_dimensions: number;
}

interface DataHealth {
  ok: boolean;
  reference_date?: string | null;
  degraded: string[];
  degraded_count?: number;
  unknown_signals?: string[];
  sources?: Record<string, boolean>;
  indices?: { name: string; ok: boolean; reason: string | null; last_date: string | null }[];
}

interface TailRiskData {
  ok: boolean;
  error?: string;
  detail?: string;
  ts: string;
  data_date: string;
  risk_level: RiskLevel;
  alert_dimensions: string[];
  watch_dimensions: string[];
  dimensions: Dimension[];
  signals: Signal[];
  vol_table: VolRow[];
  vix_term: {
    vix9d: number | null;
    vix: number | null;
    vix3m: number | null;
    vix6m: number | null;
    backwardation_front: boolean | null;
    backwardation_back: boolean | null;
  };
  fear_greed: number | null;
  spy_rsi: number | null;
  sector_regime: string | null;
  sector_corr: number | null;
  crisis_level: number | null;
  dcc_v1_signal: string;
  dcc_v3_signal: string;
  history: HistoryItem[];
  data_health: DataHealth;
}

// ── Palette ───────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<DimensionStatus, { fg: string; bg: string; border: string }> = {
  ALERT: { fg: "#FF3333", bg: "#1a0000", border: "#4d0000" },
  WATCH: { fg: "#FFAA00", bg: "#151000", border: "#3d2a00" },
  NORMAL: { fg: "#44AA66", bg: "#040a06", border: "#16241a" },
  UNKNOWN: { fg: "#777777", bg: "#0a0a0a", border: "#222222" },
};

const RISK_COLOR: Record<RiskLevel, { fg: string; bg: string }> = {
  HIGH: { fg: "#FF2222", bg: "#1a0000" },
  ELEVATED: { fg: "#FF8800", bg: "#1a0a00" },
  CAUTION: { fg: "#FFCC00", bg: "#1a1500" },
  NORMAL: { fg: "#22CC66", bg: "#001a08" },
};

const VERDICT_COLOR: Record<string, string> = {
  USEFUL: "#88DD44",
  SENSITIVE: "#FFAA00",
  MIXED: "#AAAAAA",
  WEAK: "#FF6644",
  UNVALIDATED: "#555566",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number | string | null, digits = 2): string {
  if (v == null) return "--";
  if (typeof v === "string") return v;
  return v.toFixed(digits);
}

function signed(v: number | null, digits = 2): string {
  if (v == null) return "--";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

// ── VIX term structure curve ──────────────────────────────────────────────────

function VixTermCurve({ term }: { term: TailRiskData["vix_term"] }) {
  const pts = [
    { label: "9D", value: term.vix9d },
    { label: "30D", value: term.vix },
    { label: "3M", value: term.vix3m },
    { label: "6M", value: term.vix6m },
  ];
  const usable = pts.filter((p) => p.value != null) as { label: string; value: number }[];
  const inverted = term.backwardation_front === true || term.backwardation_back === true;

  const W = 200;
  const H = 66;
  const PAD_X = 18;
  const PAD_Y = 10;

  let path = "";
  let coords: { x: number; y: number; p: { label: string; value: number } }[] = [];
  if (usable.length >= 2) {
    const vals = usable.map((p) => p.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    coords = usable.map((p, i) => ({
      x: PAD_X + (i * (W - PAD_X * 2)) / (usable.length - 1),
      y: PAD_Y + (1 - (p.value - min) / span) * (H - PAD_Y * 2),
      p,
    }));
    path = coords
      .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
      .join(" ");
  }

  return (
    <div
      className="flex flex-col gap-1 p-2 border"
      style={{
        borderColor: inverted ? "#CC2200" : "#1e1e1e",
        backgroundColor: inverted ? "#140000" : "#070707",
      }}
    >
      <div className="flex items-center justify-between">
        <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>VIX TERM</span>
        <span
          style={{
            color: inverted ? "#FF4444" : "#44AA66",
            fontSize: 7,
            fontWeight: "bold",
          }}
        >
          {term.backwardation_front == null && term.backwardation_back == null
            ? "NO DATA"
            : inverted
              ? "BACKWARDATION"
              : "CONTANGO"}
        </span>
      </div>

      {coords.length >= 2 ? (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
          <title>VIX term structure</title>
          <path d={path} fill="none" stroke={inverted ? "#FF4444" : "#FFD700"} strokeWidth={1.2} />
          {coords.map((c) => (
            <g key={c.p.label}>
              <circle cx={c.x} cy={c.y} r={2} fill={inverted ? "#FF4444" : "#FFD700"} />
              <text
                x={c.x}
                y={c.y - 5}
                textAnchor="middle"
                fill="#CCCCCC"
                style={{ fontSize: 7, fontFamily: "monospace" }}
              >
                {c.p.value.toFixed(1)}
              </text>
              <text
                x={c.x}
                y={H - 1}
                textAnchor="middle"
                fill="#555"
                style={{ fontSize: 6.5, fontFamily: "monospace" }}
              >
                {c.p.label}
              </text>
            </g>
          ))}
        </svg>
      ) : (
        <div style={{ color: "#555", fontSize: 8, padding: "12px 0", textAlign: "center" }}>
          TERM STRUCTURE UNAVAILABLE
        </div>
      )}

      <div className="flex justify-between" style={{ fontSize: 6.5 }}>
        <span style={{ color: term.backwardation_front ? "#FF4444" : "#333" }}>
          FRONT {term.backwardation_front == null ? "N/A" : term.backwardation_front ? "INV" : "OK"}
        </span>
        <span style={{ color: term.backwardation_back ? "#FF4444" : "#333" }}>
          BACK {term.backwardation_back == null ? "N/A" : term.backwardation_back ? "INV" : "OK"}
        </span>
      </div>
    </div>
  );
}

// ── Volatility board ──────────────────────────────────────────────────────────

function VolBoard({ rows }: { rows: VolRow[] }) {
  return (
    <div className="flex flex-col gap-1 p-2 border" style={{ borderColor: "#1e1e1e" }}>
      <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>VOL BOARD</span>
      <div
        className="grid items-center"
        style={{ gridTemplateColumns: "42px 1fr 40px 34px 30px", fontSize: 6.5, color: "#444" }}
      >
        <span>INDEX</span>
        <span className="text-right">LEVEL</span>
        <span className="text-right">Δ1D</span>
        <span className="text-right">Z63</span>
        <span className="text-right">%ILE</span>
      </div>
      {rows.map((r) => {
        const hot = r.z63 != null && r.z63 > 1.5;
        return (
          <div
            key={r.name}
            className="grid items-center"
            style={{
              gridTemplateColumns: "42px 1fr 40px 34px 30px",
              fontSize: 8,
              opacity: r.ok ? 1 : 0.45,
            }}
            title={r.ok ? `${r.description} · ${r.source} · ${r.last_date}` : (r.reason ?? "")}
          >
            <span style={{ color: hot ? "#FF8800" : "#999", fontWeight: hot ? "bold" : "normal" }}>
              {r.name}
            </span>
            {r.ok ? (
              <>
                <span className="text-right" style={{ color: "#FFD700" }}>
                  {fmt(r.value)}
                </span>
                <span
                  className="text-right"
                  style={{
                    color: r.change_1d == null ? "#444" : r.change_1d >= 0 ? "#FF6666" : "#44AA66",
                  }}
                >
                  {signed(r.change_1d)}
                </span>
                <span className="text-right" style={{ color: hot ? "#FF8800" : "#777" }}>
                  {fmt(r.z63)}
                </span>
                <span className="text-right" style={{ color: "#666" }}>
                  {r.pctile_1y == null ? "--" : r.pctile_1y.toFixed(0)}
                </span>
              </>
            ) : (
              <span className="col-span-4 text-right" style={{ color: "#B06000", fontSize: 7 }}>
                NO DATA
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Dimension card ────────────────────────────────────────────────────────────

function SignalRow({ sig }: { sig: Signal }) {
  const dot = sig.state === "on" ? "#FF4444" : sig.state === "unknown" ? "#B06000" : "#243024";
  const labelColor =
    sig.state === "on" ? "#FFCC44" : sig.state === "unknown" ? "#8a6a3a" : "#6a6a6a";

  return (
    <div
      className="flex items-center gap-1.5 py-0.5"
      title={`${sig.rule}\n${sig.why}${sig.reason ? `\n\nUnavailable: ${sig.reason}` : ""}`}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          backgroundColor: dot,
          flexShrink: 0,
        }}
      />
      <span className="truncate" style={{ color: labelColor, fontSize: 8.5 }}>
        {sig.label}
      </span>

      {!sig.validated && (
        <span
          style={{
            color: VERDICT_COLOR.UNVALIDATED,
            fontSize: 6,
            border: "1px solid #23232e",
            padding: "0 2px",
            flexShrink: 0,
          }}
        >
          UNVAL
        </span>
      )}

      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {sig.state === "unknown" ? (
          <span style={{ color: "#B06000", fontSize: 7 }}>NO DATA</span>
        ) : (
          <>
            {sig.value != null && (
              <span style={{ color: "#AAA", fontSize: 8 }}>
                {typeof sig.value === "number" ? sig.value.toFixed(2) : sig.value}
              </span>
            )}
            {sig.detail && <span style={{ color: "#3d3d3d", fontSize: 6.5 }}>{sig.detail}</span>}
          </>
        )}
        {sig.validated && (
          <span
            style={{ color: VERDICT_COLOR[sig.verdict] ?? "#555", fontSize: 6 }}
            title={
              sig.stats
                ? `IS precision ${((sig.stats.prec_is ?? 0) * 100).toFixed(0)}% · recall ${(
                    (sig.stats.rec_is ?? 0) * 100
                  ).toFixed(0)}%${
                    sig.stats.prec_fwd != null
                      ? ` · FWD ${(sig.stats.prec_fwd * 100).toFixed(0)}% (+${sig.stats.edge_fwd_pp}pp)`
                      : ""
                  }${sig.stats.note ? `\n${sig.stats.note}` : ""}`
                : undefined
            }
          >
            {sig.verdict}
          </span>
        )}
      </span>
    </div>
  );
}

function DimensionCard({ dim, signals }: { dim: Dimension; signals: Signal[] }) {
  const c = STATUS_COLOR[dim.status];
  const members = signals.filter((s) => s.dimension === dim.id);

  return (
    <div
      className="flex flex-col p-2 border"
      style={{ borderColor: c.border, backgroundColor: c.bg }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: c.fg, fontSize: 9, fontWeight: "bold", letterSpacing: "0.1em" }}>
          {dim.label}
        </span>
        <span
          className="px-1"
          style={{
            color: c.fg,
            backgroundColor: "#00000055",
            border: `1px solid ${c.border}`,
            fontSize: 6.5,
            fontWeight: "bold",
          }}
        >
          {dim.status}
        </span>
        <span className="ml-auto" style={{ color: "#444", fontSize: 7 }}>
          {dim.on_count}/{dim.total}
          {dim.degraded ? ` · ${dim.unknown_count} NO DATA` : ""}
        </span>
      </div>

      <span style={{ color: "#4a4a4a", fontSize: 7, marginTop: 1, marginBottom: 3 }}>
        {dim.question}
      </span>

      <div className="flex flex-col" style={{ borderTop: "1px solid #141414", paddingTop: 2 }}>
        {members.map((s) => (
          <SignalRow key={s.id} sig={s} />
        ))}
      </div>
    </div>
  );
}

// ── History ───────────────────────────────────────────────────────────────────

function HistoryChart({ history }: { history: HistoryItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={78}>
      <BarChart data={history} barSize={2} margin={{ top: 2, right: 2, bottom: 0, left: -24 }}>
        <XAxis
          dataKey="date"
          tickFormatter={(d: string) => d.slice(5)}
          tick={{ fill: "#3a3a3a", fontSize: 6.5 }}
          interval={19}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fill: "#3a3a3a", fontSize: 6.5 }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{ backgroundColor: "#0d0d0d", border: "1px solid #2a2a2a", fontSize: 9 }}
          labelStyle={{ color: "#888" }}
          formatter={(v: number, name: string) => [
            v,
            name === "signals_on" ? "Signals on" : "Alert dimensions",
          ]}
        />
        <Bar dataKey="signals_on" radius={[1, 1, 0, 0]}>
          {history.map((h) => (
            <Cell
              key={h.date}
              fill={
                h.alert_dimensions >= 2
                  ? "#FF3333"
                  : h.alert_dimensions === 1
                    ? "#FF8800"
                    : "#3a5540"
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Data health strip ─────────────────────────────────────────────────────────

function HealthStrip({ health, signals }: { health: DataHealth; signals: Signal[] }) {
  const unknown = signals.filter((s) => s.state === "unknown");
  if (unknown.length === 0) return null;

  const bySignal = unknown.map((s) => `${s.label}: ${s.reason ?? "unavailable"}`);
  const downSources = Object.entries(health.sources ?? {})
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return (
    <div
      className="shrink-0 flex items-start gap-1.5 px-3 py-1 border-b"
      style={{ borderColor: "#2a1a00", backgroundColor: "#0f0900" }}
      title={bySignal.join("\n")}
    >
      <AlertTriangle size={9} style={{ color: "#B06000", marginTop: 1, flexShrink: 0 }} />
      <span style={{ color: "#B06000", fontSize: 7.5, fontWeight: "bold" }}>DEGRADED</span>
      <span style={{ color: "#7a5a2a", fontSize: 7.5 }}>
        {unknown.length} signal{unknown.length > 1 ? "s" : ""} could not be evaluated
        {downSources.length > 0 ? ` — offline: ${downSources.join(", ")}` : ""}. They are reported
        as NO DATA, not as safe.
      </span>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function TailRiskView() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<TailRiskData>({
    queryKey: ["tail-risk-signals"],
    queryFn: () => fetch("/api/tail-risk/signals").then((r) => r.json()),
    staleTime: 240_000,
    refetchInterval: 300_000,
  });

  if (isLoading) {
    return (
      <div
        className="flex-1 flex items-center justify-center font-mono"
        style={{ color: "#444", fontSize: 11 }}
      >
        LOADING VOLATILITY SURFACE...
      </div>
    );
  }

  // `!data.signals` rather than `!data`: the endpoint used to be able to answer
  // with `{}`, which is truthy and sailed straight into a render crash.
  if (error || !data || data.ok === false || !Array.isArray(data.signals)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 font-mono">
        <span style={{ color: "#FF4444", fontSize: 11 }}>SIGNAL COMPUTATION FAILED</span>
        {data?.detail && (
          <span style={{ color: "#555", fontSize: 8, maxWidth: 460, textAlign: "center" }}>
            {data.detail}
          </span>
        )}
        <button
          type="button"
          onClick={() => refetch()}
          style={{ color: "#666", fontSize: 9, border: "1px solid #333", padding: "2px 8px" }}
        >
          RETRY
        </button>
      </div>
    );
  }

  const risk = RISK_COLOR[data.risk_level] ?? RISK_COLOR.NORMAL;

  return (
    <div className="flex flex-col h-full font-mono bg-black text-white overflow-hidden">
      {/* ── Status bar ───────────────────────────────────────────────────── */}
      <div
        className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b"
        style={{ borderColor: "#1a1a1a", backgroundColor: risk.bg }}
      >
        <span style={{ color: risk.fg, fontSize: 11, fontWeight: "bold", letterSpacing: "0.12em" }}>
          {data.risk_level}
        </span>
        <span style={{ color: "#333", fontSize: 9 }}>|</span>

        <div className="flex items-center gap-1">
          {data.dimensions.map((d) => {
            const c = STATUS_COLOR[d.status];
            return (
              <span
                key={d.id}
                className="px-1"
                style={{
                  color: c.fg,
                  border: `1px solid ${c.border}`,
                  backgroundColor: c.bg,
                  fontSize: 6.5,
                  letterSpacing: "0.05em",
                }}
                title={`${d.question} — ${d.status} (${d.on_count}/${d.total})`}
              >
                {d.label}
              </span>
            );
          })}
        </div>

        <span style={{ color: "#555", fontSize: 8 }}>
          {data.alert_dimensions.length} alert · {data.watch_dimensions.length} watch
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span style={{ color: "#3a3a3a", fontSize: 8 }}>DATA {data.data_date}</span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 px-2 py-0.5 border"
            style={{ borderColor: "#2a2a2a", color: "#666", fontSize: 8 }}
          >
            <RefreshCw size={8} className={isFetching ? "animate-spin" : ""} />
            {isFetching ? "..." : "REFRESH"}
          </button>
        </div>
      </div>

      <HealthStrip health={data.data_health} signals={data.signals} />

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex gap-2 p-2 min-h-full">
          {/* ── Left: raw volatility surface ──────────────────────────────── */}
          <div className="w-52 shrink-0 flex flex-col gap-2">
            <VixTermCurve term={data.vix_term} />
            <VolBoard rows={data.vol_table} />

            <div className="flex flex-col gap-1 p-2 border" style={{ borderColor: "#1e1e1e" }}>
              <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>CONTEXT</span>
              {[
                { label: "FEAR & GREED", val: data.fear_greed, warn: (data.fear_greed ?? 50) < 25 },
                { label: "SPY RSI 14", val: data.spy_rsi, warn: (data.spy_rsi ?? 50) < 35 },
                {
                  label: "SECTOR REGIME",
                  val: data.sector_regime,
                  warn: data.sector_regime === "CONVERGENT",
                },
                {
                  label: "SECTOR CORR",
                  val: data.sector_corr,
                  warn: (data.sector_corr ?? 0) > 0.65,
                },
                {
                  label: "CRISIS LEVEL",
                  val: data.crisis_level,
                  warn: (data.crisis_level ?? 0) >= 2,
                },
                {
                  label: "DCC V1 / HMM",
                  val: `${data.dcc_v1_signal} / ${data.dcc_v3_signal}`,
                  warn: data.dcc_v1_signal !== "NORMAL" || data.dcc_v3_signal !== "NORMAL",
                },
              ].map(({ label, val, warn }) => (
                <div key={label} className="flex justify-between items-center gap-2">
                  <span style={{ color: "#4a4a4a", fontSize: 7.5 }}>{label}</span>
                  <span
                    className="truncate"
                    style={{
                      color: val == null ? "#333" : warn ? "#FF8800" : "#888",
                      fontSize: 8,
                      fontWeight: warn ? "bold" : "normal",
                    }}
                  >
                    {val == null ? "NO DATA" : typeof val === "number" ? val.toFixed(2) : val}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-1 p-2 border" style={{ borderColor: "#1e1e1e" }}>
              <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>
                90D SIGNAL HISTORY
              </span>
              <HistoryChart history={data.history} />
              <span style={{ color: "#333", fontSize: 6.5, lineHeight: 1.4 }}>
                Bars = vol/flow signals on that day, coloured by how many dimensions reached ALERT.
                Credit and correlation are point-in-time only and are not back-filled here.
              </span>
            </div>
          </div>

          {/* ── Right: the six dimensions ──────────────────────────────────── */}
          <div
            className="flex-1 min-w-0 grid gap-2 content-start"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}
          >
            {data.dimensions.map((dim) => (
              <DimensionCard key={dim.id} dim={dim} signals={data.signals} />
            ))}

            <div
              className="p-2 border col-span-full"
              style={{ borderColor: "#111", backgroundColor: "#050505" }}
            >
              <p style={{ color: "#333", fontSize: 6.5, lineHeight: 1.5 }}>
                Risk level counts <b>dimensions</b> in ALERT, not raw signals — three VIX signals
                firing together is one observation about equity vol, restated three ways. Verdicts
                (USEFUL / SENSITIVE / WEAK / MIXED) come from the 2026-06-07 backtest at L2 (−3%)
                with a 5-day lookahead; signals marked UNVAL have no backtest behind them and are
                shown as raw evidence only. Volatility indices are sourced from CBOE daily files,
                not Yahoo, and any series lagging VIX is reported as NO DATA rather than carried
                forward.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
