"use client";

/**
 * PORT → RISK: does the book lean the same way as a crowded futures market?
 *
 * Open positions mapped to CFTC contracts (explicit for futures / ETFs /
 * crypto; US single stocks → E-mini S&P as a market-leg PROXY; Thai listings
 * have no contract and are counted as unmapped). A row is WITH CROWD when the
 * book's side matches a crowding flag — the risk being that there is little
 * left to buy (crowded long) or to cover (crowded short) when the view turns.
 *
 * Context, not a limit: weekly CFTC data (as of Tuesday); crowding flags were
 * WEAK against SPY tail days in the 2026-09-25 backtest.
 * Backend: GET /api/cot/portfolio (routers/cot.py `portfolio_crowding`).
 */

import { useQuery } from "@tanstack/react-query";

import type { Colors } from "../helpers";

interface CrowdFlag {
  id: string;
  label: string;
  side: "long" | "short";
  z: number;
  pct: number;
  why: string;
  relation: "WITH_CROWD" | "AGAINST_CROWD";
}

interface CrowdRow {
  key: string;
  label: string;
  side: "long" | "short";
  exposure: number;
  weight_pct: number | null;
  symbols: string[];
  proxy: boolean;
  focus: "lev" | "mm" | null;
  focus_z: number | null;
  focus_pct: number | null;
  flags: CrowdFlag[];
}

interface CrowdData {
  as_of: string | null;
  released: string | null;
  base_currency: string;
  rows: CrowdRow[];
  with_crowd_weight_pct: number;
  mapped_weight_pct: number | null;
  unmapped_weight_pct: number | null;
  unpriced: string[];
}

export function CotCrowdingPanel({
  accountId,
  currency,
  colors,
}: {
  accountId: string;
  currency: "THB" | "USD";
  colors: Colors;
}) {
  const { data, isLoading, error } = useQuery<CrowdData>({
    queryKey: ["cot-portfolio", accountId, currency],
    queryFn: async () => {
      const qs = new URLSearchParams({ base_currency: currency });
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/cot/portfolio?${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
  });

  const head = (
    <div className="flex items-baseline gap-2 flex-wrap">
      <span style={{ color: colors.textSecondary, fontSize: 10, letterSpacing: "0.12em" }}>
        FUTURES POSITIONING vs BOOK · CFTC
      </span>
      {data?.as_of && (
        <span style={{ color: colors.textSecondary, fontSize: 9, opacity: 0.7 }}>
          as of Tue {data.as_of.slice(5)} · released Fri {data.released?.slice(5)} · context only
        </span>
      )}
    </div>
  );

  return (
    <div
      className="rounded p-2 flex flex-col gap-1 font-mono"
      style={{ border: `1px solid ${colors.border}` }}
    >
      {head}
      {isLoading ? (
        <span style={{ color: colors.textSecondary, fontSize: 10 }}>loading…</span>
      ) : error || !data ? (
        <span style={{ color: colors.negative, fontSize: 10 }}>
          unavailable — {String(error ?? "no data")}
        </span>
      ) : data.rows.length === 0 ? (
        <span
          style={{ color: data.unpriced.length ? "#B06000" : colors.textSecondary, fontSize: 10 }}
        >
          {data.mapped_weight_pct == null && data.unpriced.length
            ? `ยังไม่มีราคาล่าสุดของ position (${data.unpriced.length} ตัว) — คำนวณขนาดไม่ได้ ลองใหม่เมื่อราคามา`
            : `ไม่มี position ที่ map กับสัญญา CFTC ได้ (${data.unmapped_weight_pct ?? 100}% ของพอร์ตไม่มีสัญญาอ้างอิง)`}
        </span>
      ) : (
        <>
          <div className="flex gap-4 flex-wrap" style={{ fontSize: 10 }}>
            <span
              style={{ color: data.with_crowd_weight_pct > 0 ? "#FF8800" : colors.textSecondary }}
            >
              WITH CROWD {data.with_crowd_weight_pct.toFixed(1)}% of book
            </span>
            <span style={{ color: colors.textSecondary }}>
              mapped {data.mapped_weight_pct?.toFixed(1) ?? "—"}% · no CFTC contract{" "}
              {data.unmapped_weight_pct?.toFixed(1) ?? "—"}%
            </span>
            {data.unpriced.length > 0 && (
              <span style={{ color: "#B06000" }} title="ไม่มีราคาล่าสุด — ไม่นับขนาด">
                unpriced: {data.unpriced.join(", ")}
              </span>
            )}
          </div>

          <div
            className="grid items-baseline gap-x-3"
            style={{
              gridTemplateColumns: "minmax(80px,1fr) auto auto auto minmax(120px,2fr)",
              fontSize: 10,
            }}
          >
            {["CONTRACT", "BOOK", "WEIGHT", "FUNDS p3Y", "CROWDING"].map((h, i) => (
              <span
                key={h}
                style={{
                  color: colors.textSecondary,
                  fontSize: 8.5,
                  textAlign: i && i < 4 ? "right" : "left",
                }}
              >
                {h}
              </span>
            ))}
            {data.rows.map((r) => (
              <div key={r.key} className="contents">
                <span
                  style={{ color: colors.text }}
                  title={`${r.symbols.join(", ")}${r.proxy ? " — US single stocks mapped to E-mini S&P as a market-leg proxy" : ""}`}
                >
                  {r.label}
                  {r.proxy && (
                    <span style={{ color: colors.textSecondary, fontSize: 8.5 }}> proxy</span>
                  )}
                </span>
                <span
                  style={{ textAlign: "right", color: r.side === "long" ? "#4CAF50" : "#FF5252" }}
                >
                  {r.side.toUpperCase()}
                </span>
                <span className="tabular-nums" style={{ textAlign: "right", color: colors.text }}>
                  {r.weight_pct == null ? "—" : `${r.weight_pct.toFixed(1)}%`}
                </span>
                <span
                  className="tabular-nums"
                  style={{ textAlign: "right", color: colors.textSecondary }}
                >
                  {r.focus_pct == null ? "—" : `p${Math.round(r.focus_pct)}`}
                </span>
                <span>
                  {r.flags.length === 0 ? (
                    <span style={{ color: colors.textSecondary }}>—</span>
                  ) : (
                    r.flags.map((f) => (
                      <span
                        key={f.id}
                        title={f.why}
                        style={{
                          color: f.relation === "WITH_CROWD" ? "#FF8800" : "#4CAF50",
                          marginRight: 6,
                        }}
                      >
                        {f.relation === "WITH_CROWD" ? "WITH" : "AGAINST"} · {f.label} (p
                        {Math.round(f.pct)})
                      </span>
                    ))
                  )}
                </span>
              </div>
            ))}
          </div>
          <span
            style={{ color: colors.textSecondary, fontSize: 8.5, opacity: 0.7, lineHeight: 1.5 }}
          >
            WITH = พอร์ตอยู่ฝั่งเดียวกับฝูงที่แออัด (เหลือคนซื้อ/คนปิด short น้อยเมื่อมุมมองเปลี่ยน) · AGAINST =
            อยู่ฝั่งตรงข้าม (ได้ประโยชน์ถ้าฝูงถูกบีบ). หุ้น US รายตัวใช้ E-mini S&P แทนความเสี่ยงตลาด
            ไม่ได้บอกอะไรเกี่ยวกับตัวหุ้น. backtest กับ SPY tail day: WEAK — ใช้เป็นบริบทเท่านั้น.
          </span>
        </>
      )}
    </div>
  );
}
