"use client";

/**
 * SECTOR ROTATION — where the US sector complex's turnover is moving.
 *
 * Called ROTATION and not FLOW on purpose. Every buy is a sale, so a share of
 * dollar volume says where attention concentrated, never that money entered a
 * sector on net. The one measure that would earn the word "flow" is
 * creation/redemption, which nobody publishes as history — so the app records
 * the AUM of the eleven funds itself, and the footer says how long that record
 * has been running. Until it has two days there is nothing to show, and saying
 * so is better than dressing turnover up as flow.
 *
 * What it is here to answer for TAIL: is the tape moving toward the sectors
 * people hold while de-risking. That is one number — the tilt — and the rows
 * below it are the evidence, not the point.
 */

import { useQuery } from "@tanstack/react-query";

type Tone = "good" | "watch" | "bad" | "unknown";

interface TiltRow {
  symbol: string;
  name: string;
  bucket: "defensive" | "cyclical" | "unaligned";
  share_pct: number | null;
  delta_bp: number | null;
  z: number | null;
  rel_return_bp: number | null;
  quadrant: string | null;
  mom_dir: string | null;
}

interface TiltData {
  as_of: string | null;
  window_days: number;
  bench: string;
  basis: string;
  basis_note: string;
  tilt: {
    state: string | null;
    tone: Tone;
    bp: number | null;
    z: number | null;
    band_bp: number;
    rule: string;
    defensive: string[];
    cyclical: string[];
    unaligned: string[];
  };
  rows: TiltRow[];
  quadrants: Record<string, number>;
  breadth: { above_bench: number; total: number };
  aum: {
    available: boolean;
    days_stored?: number;
    window_days?: number;
    first_day?: string | null;
    last_day?: string | null;
    note?: string;
    rows?: {
      symbol: string;
      aum: number;
      flow_shares_method: number | null;
      flow_return_method: number | null;
    }[];
    coverage?: { days: number; first: string | null; last: string | null };
    error?: string;
  };
  error?: string;
}

const TONE: Record<Tone, string> = {
  good: "#4CAF50",
  watch: "#FFC107",
  bad: "#FF5252",
  unknown: "#444",
};

/** Defensive money is the risk-off side, so it reads red the way a lit signal
 *  does; cyclical is green. The colour is about what the move MEANS for tail
 *  risk, not about whether the number is positive. */
const BUCKET_COLOR: Record<TiltRow["bucket"], string> = {
  defensive: "#FF5252",
  cyclical: "#4CAF50",
  unaligned: "#7A7A7A",
};

const BUCKET_TAG: Record<TiltRow["bucket"], string> = {
  defensive: "DEF",
  cyclical: "CYC",
  unaligned: "—",
};

export function useSectorRotation(window = 20) {
  return useQuery<TiltData>({
    queryKey: ["tail-sector-rotation", window],
    queryFn: () => fetch(`/api/rotation/tilt?window=${window}`).then((r) => r.json()),
    staleTime: 15 * 60_000,
    refetchInterval: 30 * 60_000,
  });
}

const bp = (v: number | null | undefined) =>
  v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(Math.round(v))}bp`;

export function SectorRotationPanel({ window = 20 }: { window?: number }) {
  const { data, isLoading } = useSectorRotation(window);
  const box = "flex flex-col gap-1 p-2 border";

  if (isLoading || !data) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>
          SECTOR ROTATION · US
        </span>
        <span style={{ color: "#333", fontSize: 7.5 }}>loading…</span>
      </div>
    );
  }
  if (data.error || !data.rows?.length) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>
          SECTOR ROTATION · US
        </span>
        <span style={{ color: "#444", fontSize: 7.5 }}>{data.error ?? "no data"}</span>
      </div>
    );
  }

  const t = data.tilt;
  const tone = TONE[t.tone ?? "unknown"];
  // One scale for every bar, so the rows are comparable to each other rather
  // than each being full-width in its own right.
  const scale = Math.max(...data.rows.map((r) => Math.abs(r.delta_bp ?? 0)), 1);
  const aumDays = data.aum?.coverage?.days ?? data.aum?.days_stored ?? 0;

  return (
    <div className={box} style={{ borderColor: "#1e1e1e" }}>
      <div className="flex items-center justify-between">
        <span style={{ color: "#888", fontSize: 8, letterSpacing: "0.12em" }}>
          SECTOR ROTATION · US
        </span>
        <span style={{ color: "#3a3a3a", fontSize: 6.5 }}>{data.window_days}D</span>
      </div>
      {/* The caveat gets its own line rather than sharing the header: the left
          column is ~208px, and a wrapped header buries the one thing a reader
          has to know before trusting the bars. */}
      <span
        style={{ color: "#3a3a3a", fontSize: 6.5 }}
        title={`${data.basis_note}\nไม่มี backtest รองรับ และไม่ถูกนับใน composite risk level`}
      >
        TURNOVER SHARE · NOT IN COMPOSITE
      </span>

      {/* The tilt — the only line here that TAIL is actually asking about. */}
      <div className="px-1 py-0.5" style={{ border: `1px solid ${tone}33` }}>
        <div className="flex items-baseline justify-between gap-2">
          <span style={{ color: "#4a4a4a", fontSize: 6.5 }}>TILT</span>
          <span style={{ color: tone, fontSize: 8, fontWeight: "bold" }}>
            {t.state ?? "NO DATA"}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2" title={t.rule}>
          <span style={{ color: "#666", fontSize: 6.5 }}>
            {t.bp == null ? "—" : `${bp(t.bp)} เข้าฝั่ง${t.bp > 0 ? "ตั้งรับ" : "วัฏจักร"}`}
          </span>
          <span style={{ color: "#555", fontSize: 6.5 }}>
            {t.z == null ? "" : `z ${t.z >= 0 ? "+" : "−"}${Math.abs(t.z).toFixed(1)} (1y)`}
          </span>
        </div>
      </div>

      {/* Diverging bars off a centre line: left is share lost, right is gained. */}
      <div className="flex flex-col" style={{ gap: 1 }}>
        {data.rows.map((r) => {
          const d = r.delta_bp ?? 0;
          const w = (Math.abs(d) / scale) * 50;
          const c = BUCKET_COLOR[r.bucket];
          return (
            <div
              key={r.symbol}
              className="flex items-center gap-1"
              title={`${r.name} · ${BUCKET_TAG[r.bucket]}\nส่วนแบ่งมูลค่าซื้อขาย ${
                r.share_pct ?? "—"
              }% ของทั้งกลุ่ม\nΔ ${bp(r.delta_bp)} เทียบหน้าต่างก่อน (z ${r.z ?? "—"})\nผลตอบแทนเทียบ ${
                data.bench
              } ${bp(r.rel_return_bp)}\nRRG ${r.quadrant ?? "—"}`}
            >
              {/* The ticker alone is a memory test — XLB and XLC are one letter
                  apart and mean nothing to read at a glance. The name carries
                  the meaning; the symbol stays because it is what the rest of
                  the terminal (and the ETF) is called. */}
              <span
                className="shrink-0"
                style={{ color: "#777", fontSize: 6.5, width: 26, fontFamily: "monospace" }}
              >
                {r.symbol}
              </span>
              <span
                className="shrink-0 truncate"
                style={{ color: "#4a4a4a", fontSize: 6.5, width: 74 }}
              >
                {r.name}
              </span>
              <div className="relative flex-1 min-w-0" style={{ height: 7 }}>
                <div
                  className="absolute"
                  style={{ left: "50%", top: 0, bottom: 0, width: 1, background: "#242424" }}
                />
                <div
                  className="absolute"
                  style={{
                    top: 1,
                    bottom: 1,
                    background: c,
                    opacity: 0.75,
                    ...(d >= 0
                      ? { left: "50%", width: `${w}%` }
                      : { right: "50%", width: `${w}%` }),
                  }}
                />
              </div>
              <span
                className="shrink-0 text-right"
                style={{ color: c, fontSize: 6.5, width: 36, fontFamily: "monospace" }}
              >
                {bp(r.delta_bp)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between" style={{ color: "#555", fontSize: 6.5 }}>
        <span title="RRG quadrants from weekly relative strength vs the benchmark">
          RRG L{data.quadrants.Leading ?? 0} · I{data.quadrants.Improving ?? 0} · W
          {data.quadrants.Weakening ?? 0} · G{data.quadrants.Lagging ?? 0}
        </span>
        <span title={`Sectors outperforming ${data.bench} over ${data.window_days} days`}>
          BREADTH {data.breadth.above_bench}/{data.breadth.total} &gt; {data.bench}
        </span>
      </div>

      {/* The AUM record. Nobody sells this history, so it only exists from the
          day the terminal started writing it down. */}
      <div
        className="flex items-center justify-between"
        style={{ color: "#444", fontSize: 6.5 }}
        title={
          data.aum?.available
            ? "Net creation/redemption ประมาณจาก AUM ที่บันทึกเอง — flow จริง ไม่ใช่ turnover"
            : "AUM record ที่แอปเก็บเอง วันละครั้ง; ต้องมี ≥2 วันถึงจะประมาณ flow จริงได้"
        }
      >
        <span>AUM RECORD {aumDays}D</span>
        <span>
          {data.aum?.available
            ? (() => {
                const top = (data.aum.rows ?? [])
                  .slice(0, 2)
                  .map(
                    (f) =>
                      `${f.symbol} ${
                        (f.flow_shares_method ?? f.flow_return_method ?? 0) >= 0 ? "+" : "−"
                      }$${(
                        Math.abs(f.flow_shares_method ?? f.flow_return_method ?? 0) / 1e6
                      ).toFixed(0)}M`
                  )
                  .join(" · ");
                return top || "no flow yet";
              })()
            : "flow ยังไม่พอข้อมูล"}
        </span>
      </div>
    </div>
  );
}
