"use client";

/**
 * Treasury futures positioning (CFTC COT) for the BOND view.
 *
 * BASIS TRADE — asset managers hold duration LONG in futures; leveraged funds
 * are the other side, short futures against cash Treasuries bought on repo.
 * The size of the lev short is the size of the cash-futures basis trade, and
 * a crowded basis trade is what unwound in March 2020 (Treasuries sold into a
 * dash for cash). Tenors are summed in 10Y-note equivalents with approximate
 * DV01 weights — adding raw 2Y and Bond contracts would mix risks ~4× apart.
 *
 * DEALER BALANCE SHEET (CONDITIONS tab) — dealers warehouse what clients do
 * not want; a dealer net position at the edge of its range is a balance sheet
 * that is full.
 *
 * Weekly, as of Tuesday, released Friday — stated in every header.
 */

import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  COT_PCT_HIGH,
  COT_PCT_LOW,
  COT_Z_EXTREME,
  type CotContract,
  cotExtreme,
  fmtContracts,
} from "../../hooks/useCot";
import { C, Panel, fmtDate } from "./ui";

interface BasisStats {
  net: number | null;
  d_net: number | null;
  z: number | null;
  pct: number | null;
  n: number;
}

interface BasisData {
  window: number;
  as_of: string | null;
  released: string | null;
  unit: string;
  stats: Record<"am" | "lev" | "dealer", BasisStats>;
  series: { date: string; released: string; am: number; lev: number; dealer: number; oi: number }[];
  tenors: (CotContract & { dv01_net: Record<string, number> })[];
  status: { running: boolean; last_error: string | null };
}

const AXIS = { fontSize: 9, fontFamily: "monospace", fill: C.dim };
const TT = {
  backgroundColor: "#0a0a0a",
  border: "1px solid #2a2a2a",
  fontSize: 10,
  fontFamily: "monospace",
};
const COLOR = { am: "#60A5FA", lev: "#FF6B6B", dealer: "#A3A3A3" };

export function useCotBasis(enabled = true) {
  return useQuery<BasisData>({
    queryKey: ["cot-basis"],
    queryFn: () => fetch("/api/cot/basis").then((r) => r.json()),
    enabled,
    staleTime: 30 * 60_000,
    refetchInterval: (q) => (q.state.data?.status?.running ? 10_000 : 60 * 60_000),
  });
}

function asOfNote(d: BasisData | undefined) {
  return d?.as_of
    ? `CFTC weekly · as of Tue ${d.as_of.slice(5)} · released Fri ${d.released?.slice(5)}`
    : "CFTC weekly";
}

function Stat({ label, s, color }: { label: string; s: BasisStats | undefined; color: string }) {
  const ex =
    s?.z != null &&
    s.pct != null &&
    (Math.abs(s.z) >= COT_Z_EXTREME || s.pct <= COT_PCT_LOW || s.pct >= COT_PCT_HIGH);
  return (
    <div
      className="flex flex-col"
      title={`z ${s?.z ?? "—"} · pct ${s?.pct ?? "—"} of net/OI over ${s?.n ?? 0} weeks`}
    >
      <span style={{ color: C.dim, fontSize: 8.5, letterSpacing: "0.1em" }}>{label}</span>
      <span className="tabular-nums" style={{ color, fontSize: 12 }}>
        {fmtContracts(s?.net)}
      </span>
      <span className="tabular-nums" style={{ color: ex ? C.amber : C.dim, fontSize: 9 }}>
        Δ {fmtContracts(s?.d_net)} · z {s?.z ?? "—"} · p{s?.pct == null ? "—" : Math.round(s.pct)}
      </span>
    </div>
  );
}

export function BasisTradePanel() {
  const { data, isLoading } = useCotBasis();

  if (isLoading || !data?.series?.length) {
    return (
      <Panel title="TREASURY FUTURES POSITIONING · BASIS TRADE" note={asOfNote(data)}>
        <span style={{ color: "#666", fontSize: 10 }}>
          {data?.status?.running ? "กำลังดึงประวัติจาก CFTC…" : isLoading ? "LOADING…" : "NO DATA"}
        </span>
      </Panel>
    );
  }

  const rows = data.series.map((r) => ({
    date: r.date,
    am: r.am / 1e6,
    lev: -r.lev / 1e6, // plotted as a positive size so the two legs sit side by side
    dealer: r.dealer / 1e6,
  }));

  return (
    <Panel title="TREASURY FUTURES POSITIONING · BASIS TRADE" note={asOfNote(data)}>
      <div className="flex gap-4 flex-wrap">
        <Stat label="ASSET MGR NET (LONG)" s={data.stats.am} color={COLOR.am} />
        <Stat label="LEV FUNDS NET (SHORT)" s={data.stats.lev} color={COLOR.lev} />
        <Stat label="DEALER NET" s={data.stats.dealer} color={COLOR.dealer} />
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#141414" />
          <XAxis dataKey="date" tick={AXIS} tickFormatter={fmtDate} minTickGap={40} />
          <YAxis tick={AXIS} width={36} tickFormatter={(v) => `${v}M`} />
          <ReferenceLine y={0} stroke="#333" />
          <Tooltip
            contentStyle={TT}
            labelStyle={{ color: "#aaa" }}
            formatter={(v: number, name: string) => [
              `${v.toFixed(2)}M`,
              name === "am"
                ? "ASSET MGR net"
                : name === "lev"
                  ? "LEV FUNDS short (size)"
                  : "DEALER net",
            ]}
          />
          <Line
            dataKey="am"
            stroke={COLOR.am}
            dot={false}
            strokeWidth={1.4}
            isAnimationActive={false}
          />
          <Line
            dataKey="lev"
            stroke={COLOR.lev}
            dot={false}
            strokeWidth={1.4}
            isAnimationActive={false}
          />
          <Line
            dataKey="dealer"
            stroke={COLOR.dealer}
            dot={false}
            strokeWidth={1}
            strokeDasharray="3 3"
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <div
        className="grid items-baseline gap-x-3"
        style={{
          gridTemplateColumns: "minmax(60px,1fr) repeat(4, auto)",
          borderTop: "1px solid #141414",
          paddingTop: 2,
        }}
      >
        {["TENOR · 10Y-eq", "ASSET MGR", "LEV FUNDS", "LEV p3Y", "TOP4 SHORT"].map((h, i) => (
          <span key={h} style={{ color: C.dim, fontSize: 8.5, textAlign: i ? "right" : "left" }}>
            {h}
          </span>
        ))}
        {data.tenors.map((t) => {
          const lev = t.groups.lev;
          const ex = cotExtreme(lev);
          return (
            <div key={t.code} className="contents">
              <span
                style={{ color: "#9a9a9a", fontSize: 9.5 }}
                title={`DV01 ×${t.dv01} · OI ${fmtContracts(t.oi)}`}
              >
                {t.label}
              </span>
              <span
                className="tabular-nums"
                style={{ color: COLOR.am, fontSize: 9.5, textAlign: "right" }}
              >
                {fmtContracts(t.dv01_net.am)}
              </span>
              <span
                className="tabular-nums"
                style={{ color: COLOR.lev, fontSize: 9.5, textAlign: "right" }}
              >
                {fmtContracts(t.dv01_net.lev)}
              </span>
              <span
                className="tabular-nums"
                style={{ color: ex ? C.amber : "#777", fontSize: 9.5, textAlign: "right" }}
                title={`net/OI ${lev?.net_oi ?? "—"}% · z ${lev?.z ?? "—"}`}
              >
                p{lev?.pct == null ? "—" : Math.round(lev.pct)}
              </span>
              <span
                className="tabular-nums"
                style={{ color: "#777", fontSize: 9.5, textAlign: "right" }}
              >
                {t.conc4_short == null ? "—" : `${t.conc4_short.toFixed(0)}%`}
              </span>
            </div>
          );
        })}
      </div>
      <span style={{ color: "#555", fontSize: 9, lineHeight: 1.5 }}>
        LEV short ≈ ขนาด basis trade (short futures + long cash บน repo) ไม่ใช่การเดิมพันขาลง. short ใหญ่
        + repo ตึง/vol พุ่ง = เสี่ยงถูกบังคับปิดแบบ มี.ค. 2020. p = percentile ของ net/OI ใน 3 ปี (สูง = short
        น้อยเทียบ OI). DV01 เป็นค่าประมาณ.
      </span>
    </Panel>
  );
}

export function DealerBalanceSheetPanel() {
  const { data } = useCotBasis();
  const s = data?.stats?.dealer;
  const rows = (data?.series ?? [])
    .slice(-156)
    .map((r) => ({ date: r.date, dealer: r.dealer / 1e6 }));
  return (
    <Panel title="DEALER BALANCE SHEET · UST FUTURES" note={asOfNote(data)}>
      {!rows.length ? (
        <span style={{ color: "#666", fontSize: 10 }}>
          {data?.status?.running ? "กำลังดึงจาก CFTC…" : "NO DATA"}
        </span>
      ) : (
        <>
          <Stat label="DEALER NET · 10Y-eq" s={s} color={COLOR.dealer} />
          <ResponsiveContainer width="100%" height={110}>
            <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#141414" />
              <XAxis dataKey="date" tick={AXIS} tickFormatter={fmtDate} minTickGap={40} />
              <YAxis tick={AXIS} width={36} tickFormatter={(v) => `${v}M`} />
              <Tooltip
                contentStyle={TT}
                formatter={(v: number) => [`${v.toFixed(2)}M`, "DEALER net"]}
              />
              <Line
                dataKey="dealer"
                stroke={COLOR.dealer}
                dot={false}
                strokeWidth={1.3}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <span style={{ color: "#555", fontSize: 9, lineHeight: 1.5 }}>
            Dealer รับฝั่งที่ลูกค้าไม่เอา — net สุดขอบช่วง 3 ปี = งบดุลตึง รับเพิ่มได้น้อย. บริบท ไม่นับใน crisis level.
          </span>
        </>
      )}
    </Panel>
  );
}
