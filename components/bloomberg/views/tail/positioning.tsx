"use client";

/**
 * POSITIONING — who holds the futures (CFTC Commitments of Traders).
 *
 * The FLOW / POSITIONING dimension infers positioning from price (RSI, volume,
 * Fear & Greed). This panel shows the positions themselves: net of leveraged
 * funds (managed money for commodities) and asset managers as % of open
 * interest, placed within their own 3-year range.
 *
 * Context, not a trigger: a crowded book is the fuel for a forced unwind, but
 * it can stay crowded for months. The matching `cot_crowding` signal is shown
 * in its dimension card and NOT counted in the risk level: the 2026-09-25
 * backtest (backtest-idea/06_cot_crowding) found it WEAK against SPY tail days —
 * some flag is lit most weeks. Weekly and 3 days late by design — the header
 * says so.
 */

import {
  type CotContract,
  type CotGroupStats,
  cotExtreme,
  fmtContracts,
  useCotSnapshot,
} from "../../hooks/useCot";

const CLASS_ORDER: CotContract["class"][] = ["rates", "vol", "equity", "fx", "crypto", "commod"];
const CLASS_LABEL: Record<CotContract["class"], string> = {
  rates: "RATES",
  vol: "VOL",
  equity: "EQUITY",
  fx: "FX",
  crypto: "CRYPTO",
  commod: "COMMOD",
};

const SHORT = "#FF5252";
const LONG = "#4CAF50";

function Cell({ g, title }: { g: CotGroupStats | undefined; title: string }) {
  if (!g) return <span style={{ color: "#333", fontSize: 9.5, textAlign: "right" }}>—</span>;
  const ex = cotExtreme(g);
  const color = ex === "short" ? SHORT : ex === "long" ? LONG : "#8a8a8a";
  return (
    <span
      className="tabular-nums"
      style={{ color, fontSize: 9.5, textAlign: "right", fontWeight: ex ? "bold" : "normal" }}
      title={`${title}\nnet ${fmtContracts(g.net)} (${g.net_oi.toFixed(1)}% OI) · Δ1w ${fmtContracts(
        g.d_net
      )}\nz ${g.z ?? "—"} · pct ${g.pct ?? "—"} (n=${g.n})\ntraders L/S ${g.traders_long ?? "—"}/${
        g.traders_short ?? "—"
      }`}
    >
      {g.net_oi >= 0 ? "+" : "−"}
      {Math.abs(g.net_oi).toFixed(1)}%
      <span style={{ color: ex ? color : "#555", fontWeight: "normal" }}>
        {" "}
        p{g.pct == null ? "—" : Math.round(g.pct)}
      </span>
    </span>
  );
}

export function PositioningPanel({ enabled = true }: { enabled?: boolean }) {
  const { data, isLoading } = useCotSnapshot(enabled);
  const box = "flex flex-col gap-1 p-2 border";

  if (isLoading || !data) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={{ color: "#888", fontSize: 10, letterSpacing: "0.12em" }}>
          POSITIONING · CFTC
        </span>
        <span style={{ color: "#555", fontSize: 9.5 }}>loading…</span>
      </div>
    );
  }

  if (!data.contracts?.length) {
    return (
      <div className={box} style={{ borderColor: "#1e1e1e" }}>
        <span style={{ color: "#888", fontSize: 10, letterSpacing: "0.12em" }}>
          POSITIONING · CFTC
        </span>
        <span style={{ color: "#8a6a3a", fontSize: 9.5 }}>
          {data.status?.running
            ? "กำลังดึงประวัติจาก CFTC ครั้งแรก (~1 นาที)…"
            : data.status?.last_error
              ? `NO DATA — ${data.status.last_error}`
              : "NO DATA"}
        </span>
      </div>
    );
  }

  const behind =
    data.as_of && data.status?.expected_as_of && data.as_of < data.status.expected_as_of;
  const rows = [...data.contracts].sort(
    (a, b) => CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class)
  );

  return (
    <div className={box} style={{ borderColor: "#1e1e1e" }}>
      <div className="flex items-baseline gap-2">
        <span style={{ color: "#888", fontSize: 10, letterSpacing: "0.12em" }}>
          POSITIONING · CFTC
        </span>
        <span
          style={{ color: behind ? "#B06000" : "#5a5a5a", fontSize: 9 }}
          title="ตำแหน่ง ณ วันอังคาร ประกาศวันศุกร์ 15:30 ET — ข้อมูลรายสัปดาห์ ช้า 3 วันเสมอ"
        >
          as of Tue {data.as_of?.slice(5)} · released Fri {data.released?.slice(5)}
          {behind ? ` · BEHIND (expect ${data.status.expected_as_of.slice(5)})` : ""}
        </span>
      </div>

      {/* Flags first — the one-line answer */}
      {data.flags.length === 0 ? (
        <span style={{ color: "#5a5a5a", fontSize: 9.5 }}>
          no crowding flag (|z| ≥ 2 or pct ≤ 5 / ≥ 95)
        </span>
      ) : (
        <div className="flex flex-col">
          {data.flags.map((f) => (
            <div
              key={`${f.id}-${f.contract}`}
              className="flex items-center gap-1.5"
              style={{ lineHeight: 1.6 }}
              title={f.why}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  backgroundColor: f.side === "short" ? SHORT : LONG,
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "#FFCC44", fontSize: 10 }}>{f.label}</span>
              <span style={{ color: "#777", fontSize: 9.5 }}>{f.contract_label}</span>
              <span className="ml-auto tabular-nums" style={{ color: "#AAA", fontSize: 9.5 }}>
                z {f.z >= 0 ? "+" : ""}
                {f.z.toFixed(1)} · p{Math.round(f.pct)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Table: focus group (lev / managed money) + asset managers */}
      <div
        className="grid items-baseline gap-x-2"
        style={{
          gridTemplateColumns: "minmax(70px,1fr) auto auto auto",
          borderTop: "1px solid #141414",
          paddingTop: 2,
        }}
      >
        <span style={{ color: "#555", fontSize: 8.5 }}>NET % OI · pct 3Y</span>
        <span style={{ color: "#555", fontSize: 8.5, textAlign: "right" }}>FUNDS</span>
        <span style={{ color: "#555", fontSize: 8.5, textAlign: "right" }}>ASSET MGR</span>
        <span
          style={{ color: "#555", fontSize: 8.5, textAlign: "right" }}
          title="top-4 traders' gross short, % OI"
        >
          TOP4 S
        </span>
        {rows.map((c, i) => {
          const newClass = i === 0 || rows[i - 1].class !== c.class;
          return (
            <div key={c.code} className="contents">
              {newClass && (
                <span
                  style={{
                    gridColumn: "1 / -1",
                    color: "#4a4a4a",
                    fontSize: 8,
                    letterSpacing: "0.15em",
                    paddingTop: 2,
                  }}
                >
                  {CLASS_LABEL[c.class]}
                </span>
              )}
              <span
                className="truncate"
                style={{ color: "#9a9a9a", fontSize: 9.5 }}
                title={`${c.label} · OI ${fmtContracts(c.oi)}`}
              >
                {c.label}
              </span>
              <Cell
                g={c.groups[c.focus]}
                title={c.focus === "mm" ? "Managed money" : "Leveraged funds"}
              />
              <Cell g={c.groups.am} title="Asset managers / institutional" />
              <span
                className="tabular-nums"
                style={{ color: "#666", fontSize: 9.5, textAlign: "right" }}
              >
                {c.conc4_short == null ? "—" : `${c.conc4_short.toFixed(0)}%`}
              </span>
            </div>
          );
        })}
      </div>

      <span style={{ color: "#4a4a4a", fontSize: 8.5, lineHeight: 1.5 }}>
        แดง = short แออัด · เขียว = long แออัด (net/OI เทียบ 3 ปีของตัวเอง). Lev short UST ส่วนใหญ่เป็นขา
        hedge ของ basis trade ไม่ใช่การเดิมพันขาลง. ไม่นับใน risk level — backtest 2026-09-25 กับ SPY tail
        day: WEAK (ติดเกือบทุกวัน).
      </span>
    </div>
  );
}
