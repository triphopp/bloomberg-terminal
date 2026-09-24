"use client";

/**
 * Two decompositions the event classifier reads, shown as numbers:
 *
 *   REAL RATES — nominal = real (TIPS) + breakeven. A yield move the
 *   breakeven did not share is a real-rate move: policy or term premium,
 *   not inflation fear. That distinction decides whether gold and long-
 *   duration equities should be hurt, and is invisible in the nominal alone.
 *
 *   ENERGY — crude → refined products. Crack spreads ($/bbl) are what fuel
 *   buyers pay above crude; a diesel crack at the top of its range reaches
 *   freight costs and CPI without crude moving at all.
 *
 * Source: `decomposition` on /api/tail-risk/signals. REAL rows marked EST are
 * carried past FRED's last DFII print with nominal − breakeven; changes on a
 * futures-roll session are blanked (ROLL) because they measure the contract
 * switch, not the market.
 */

export interface DecompRow {
  key: string;
  label: string;
  short?: string;
  value: number | null;
  unit?: string;
  level_unit?: string;
  change?: number | null;
  change5?: number | null;
  z1?: number | null;
  pctile_1y?: number | null;
  date?: string | null;
  estimated?: boolean;
  roll_day?: boolean;
}

export interface Decomposition {
  real_rates?: DecompRow[];
  energy?: DecompRow[];
}

const up = "#FF6666";
const down = "#44AA66";

function chg(v: number | null | undefined, unit: string | undefined): string {
  if (v == null) return "--";
  const d = unit === "bp" ? 1 : 2;
  return `${v >= 0 ? "+" : ""}${v.toFixed(d)}${unit === "%" ? "%" : unit === "bp" ? "bp" : ""}`;
}

function level(r: DecompRow): string {
  if (r.value == null) return "--";
  if (r.level_unit === "%") return `${r.value.toFixed(2)}%`;
  if (r.level_unit === "$") return `$${r.value.toFixed(2)}`;
  return r.value.toFixed(r.value < 10 ? 3 : 2);
}

function Row({ r, indent, refDate }: { r: DecompRow; indent?: boolean; refDate?: string | null }) {
  // A slow series still on an earlier session than the row it sits under.
  const lag = refDate && r.date && r.date !== refDate ? r.date.slice(5) : null;
  const hot = r.z1 != null && Math.abs(r.z1) >= 2;
  const pctHot = r.pctile_1y != null && r.pctile_1y >= 90;
  return (
    <div
      className="grid items-baseline"
      style={{
        gridTemplateColumns: "1fr 64px 60px 40px 32px",
        fontSize: 10.5,
        lineHeight: 1.6,
        opacity: r.value == null ? 0.4 : 1,
      }}
      title={`${r.label}${r.date ? ` · ${r.date}` : ""}${r.change5 != null ? ` · 5d ${chg(r.change5, r.unit)}` : ""}`}
    >
      <span
        className="truncate"
        style={{ color: indent ? "#777" : "#AAA", paddingLeft: indent ? 8 : 0 }}
      >
        {r.short ?? r.label}
        {lag && <span style={{ color: "#8a6a3a", fontSize: 8.5 }}> {lag}</span>}
        {r.estimated && (
          <span
            style={{ color: "#B06000", fontSize: 8.5 }}
            title="FRED has not published this session — estimated as last TIPS print + Δnominal − Δbreakeven"
          >
            {" "}
            EST
          </span>
        )}
      </span>
      <span className="text-right" style={{ color: "#FFD700" }}>
        {level(r)}
      </span>
      <span
        className="text-right"
        style={{
          color: r.roll_day ? "#555" : r.change == null ? "#444" : r.change >= 0 ? up : down,
        }}
        title={r.roll_day ? "Futures contract rolled this session — change not scored" : undefined}
      >
        {r.roll_day ? "ROLL" : chg(r.change, r.unit)}
      </span>
      <span className="text-right" style={{ color: hot ? "#FF8800" : "#555" }}>
        {r.z1 == null ? "" : `${r.z1 >= 0 ? "+" : ""}${r.z1.toFixed(1)}σ`}
      </span>
      <span className="text-right" style={{ color: pctHot ? "#FF8800" : "#555" }}>
        {r.pctile_1y == null ? "" : r.pctile_1y.toFixed(0)}
      </span>
    </div>
  );
}

function Header({ title, note }: { title: string; note: string }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span style={{ color: "#9a9a9a", fontSize: 10, letterSpacing: "0.12em" }}>{title}</span>
        <span style={{ color: "#555", fontSize: 9 }}>{note}</span>
      </div>
      <div
        className="grid"
        style={{ gridTemplateColumns: "1fr 64px 60px 40px 32px", fontSize: 9, color: "#555" }}
      >
        <span />
        <span className="text-right">LEVEL</span>
        <span className="text-right">Δ1D</span>
        <span className="text-right">Z</span>
        <span className="text-right">%ILE</span>
      </div>
    </>
  );
}

/** Nominal = real + breakeven, per tenor, with the split of today's move. */
export function RealRatesPanel({ rows }: { rows: DecompRow[] | undefined }) {
  const by = new Map((rows ?? []).map((r) => [r.key, r]));
  const tenors = [
    { t: "5Y", n: by.get("UST5Y"), r: by.get("REAL5"), b: by.get("BE5") },
    { t: "10Y", n: by.get("UST10Y"), r: by.get("REAL10"), b: by.get("BE10") },
  ];
  return (
    <div
      className="flex flex-col gap-1 p-2 border"
      style={{ borderColor: "#1e1e1e" }}
      title="Real yield = ต้นทุนเงินหลังหักเงินเฟ้อคาดการณ์ · ใช้ discount หุ้นเติบโต และแข่งกับทองคำ · FRED DFII5/DFII10 + T5YIE/T10YIE · EST = ประมาณจาก nominal − breakeven เพราะ FRED ออกช้า 1 วัน"
    >
      <Header title="REAL RATES" note="nominal = real + BE" />
      {tenors.map(({ t, n, r, b }) => {
        const dr = r?.change ?? null;
        const db = b?.change ?? null;
        const dn = n?.change ?? null;
        // Only split a move whose three legs are the same session — intraday
        // nominal against yesterday's TIPS print is two different days.
        const sameDay = !!n?.date && n.date === r?.date && n.date === b?.date;
        const split =
          sameDay && dr != null && db != null && dn
            ? `→ ${Math.abs(dr) >= Math.abs(db) ? "real yield นำ" : "เงินเฟ้อคาดการณ์นำ"} (${chg(dr, "bp")} / ${chg(db, "bp")})`
            : null;
        return (
          <div key={t} className="flex flex-col">
            {n && <Row r={n} />}
            {r && <Row r={r} indent refDate={n?.date} />}
            {b && <Row r={b} indent refDate={n?.date} />}
            {split && (
              <span style={{ color: "#C8C8C8", fontSize: 10.5, paddingLeft: 8, paddingBottom: 4 }}>
                {split}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Crude, products and the margins between them. */
export function EnergySpreadsPanel({ rows }: { rows: DecompRow[] | undefined }) {
  const list = rows ?? [];
  const spreads = new Set(["BRENT_WTI", "DIESEL_CRACK", "GAS_CRACK", "CRACK_321"]);
  return (
    <div
      className="flex flex-col gap-1 p-2 border"
      style={{ borderColor: "#1e1e1e" }}
      title="Diesel crack = HO×42 − WTI · Gas crack = RB×42 − WTI · 3-2-1 = (2·RB + HO)×42/3 − WTI · %ILE = percentile 1 ปี · ROLL = วันเปลี่ยนสัญญา ไม่นับ · RBOB เปลี่ยนเกรด เม.ย./ก.ย."
    >
      <Header title="ENERGY SPREADS" note="$/bbl" />
      {list.map((r) => (
        <Row key={r.key} r={r} indent={spreads.has(r.key)} />
      ))}
    </div>
  );
}
