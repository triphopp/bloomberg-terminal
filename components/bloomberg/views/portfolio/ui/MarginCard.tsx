"use client";

/**
 * MARGIN · REG T — IBKR-style account margin for one account (PORT or PAPER).
 *
 * Level from Cushion = Excess Liquidity / Net Liq (SAFE → WATCH → WARNING →
 * DANGER → LIQUIDATION when EL < 0, the point IBKR sells without a call). Each
 * underlying gets its own colour from how far IT ALONE must move before EL < 0.
 * `accountId === "all"` shows one line per margin-enabled account instead.
 * Backend + model: backend/routers/margin.py, backend/margin.py.
 */

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import type { Colors } from "../helpers";
import { fmt, fmtAmt, fmtPx, fmtQty } from "../helpers";
import {
  LEVEL_COLOR,
  LEVEL_TEXT,
  type MarginLevel,
  type MarginScope,
  type MarginSettings,
  type MarginStatusOn,
  pct1,
  saveMarginSettings,
  useMarginOverview,
  useMarginStatus,
} from "./margin";

const LEVEL_ORDER: MarginLevel[] = ["SAFE", "WATCH", "WARNING", "DANGER", "LIQUIDATION"];

export function MarginCard({
  scope,
  accountId,
  colors,
}: {
  scope: MarginScope;
  accountId: string;
  colors: Colors;
}) {
  if (accountId === "all") return <MarginOverviewCard scope={scope} colors={colors} />;
  return <MarginAccountCard scope={scope} accountId={accountId} colors={colors} />;
}

// ── All accounts ─────────────────────────────────────────────────────────────

function MarginOverviewCard({ scope, colors }: { scope: MarginScope; colors: Colors }) {
  const { data } = useMarginOverview();
  const rows = (data?.accounts ?? []).filter((a) => a.scope === scope);
  if (!rows.length) return null; // nothing on margin — no card
  return (
    <div className="rounded p-2 mb-2 font-mono" style={{ border: `1px solid ${colors.border}` }}>
      <div className="flex items-baseline gap-2 mb-1">
        <Title colors={colors} />
        <span style={{ color: colors.textSecondary, fontSize: 9 }}>เลือกบัญชีด้านบนเพื่อดูราย asset</span>
      </div>
      <table className="w-full text-[9px] tabular-nums">
        <thead>
          <tr style={{ color: colors.textSecondary }}>
            {["ACCOUNT", "LEVEL", "CUSHION", "EXCESS LIQ", "MAINT", "NET LIQ", "DROP→CALL"].map(
              (h, i) => (
                <th key={h} className={`px-1 text-[7px] ${i > 1 ? "text-right" : "text-left"}`}>
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const c = a.level ? LEVEL_COLOR[a.level] : colors.textSecondary;
            return (
              <tr key={a.account_id} style={{ borderTop: `1px solid ${colors.borderFaint}` }}>
                <td className="px-1" style={{ color: colors.text }}>
                  {a.name ?? a.account_id}
                </td>
                <td className="px-1 font-bold" style={{ color: c }}>
                  ● {a.level ?? (a.error ? "ERROR" : "…")}
                </td>
                <td className="px-1 text-right" style={{ color: c }}>
                  {pct1(a.cushion)}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {a.excess_liquidity != null ? fmtAmt(a.excess_liquidity) : "—"}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {a.maint_margin != null ? fmtAmt(a.maint_margin) : "—"}
                </td>
                <td className="px-1 text-right" style={{ color: colors.text }}>
                  {a.nlv != null ? fmtAmt(a.nlv) : "—"}
                </td>
                <td className="px-1 text-right" style={{ color: c }}>
                  {a.drop_to_call == null ? "—" : `−${pct1(a.drop_to_call)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── One account ──────────────────────────────────────────────────────────────

function Title({ colors }: { colors: Colors }) {
  return (
    <span style={{ color: colors.textSecondary, fontSize: 10, letterSpacing: "0.12em" }}>
      MARGIN · REG T
    </span>
  );
}

function MarginAccountCard({
  scope,
  accountId,
  colors,
}: {
  scope: MarginScope;
  accountId: string;
  colors: Colors;
}) {
  const { data, isLoading, error } = useMarginStatus(scope, accountId);
  const [editing, setEditing] = useState(false);
  const [showLines, setShowLines] = useState(false);

  const box = (children: ReactNode) => (
    <div
      className="rounded p-2 mb-2 flex flex-col gap-1 font-mono"
      style={{ border: `1px solid ${colors.border}` }}
    >
      {children}
    </div>
  );

  if (isLoading || !data)
    return box(
      <div className="flex gap-2 items-baseline">
        <Title colors={colors} />
        <span style={{ color: colors.textSecondary, fontSize: 9 }}>
          {error ? `โหลดไม่ได้ (${(error as Error).message})` : "กำลังคำนวณ…"}
        </span>
      </div>
    );

  if (!data.enabled)
    return box(
      <>
        <div className="flex gap-2 items-baseline flex-wrap">
          <Title colors={colors} />
          <span style={{ color: colors.textSecondary, fontSize: 9 }}>
            ปิดอยู่ — บัญชีนี้คิดเป็น cash account
          </span>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="ml-auto text-[9px] px-2 py-0.5 border font-bold"
            style={{ borderColor: colors.accent, color: colors.accent }}
          >
            {editing ? "CANCEL" : "ENABLE MARGIN"}
          </button>
        </div>
        {editing && (
          <SettingsForm
            initial={{ ...data.settings, enabled: true }}
            colors={colors}
            onDone={() => setEditing(false)}
          />
        )}
      </>
    );

  const d = data as MarginStatusOn;
  const c = LEVEL_COLOR[d.level];
  const ccy = d.currency;

  return box(
    <>
      <div className="flex items-baseline gap-2 flex-wrap">
        <Title colors={colors} />
        <span style={{ color: c, fontSize: 12, fontWeight: 700 }}>● {d.level}</span>
        <span style={{ color: c, fontSize: 10 }}>{LEVEL_TEXT[d.level]}</span>
        {d.restricted && (
          <span
            className="px-1 text-[8px] font-bold"
            style={{ background: "#FF444422", color: "#FF4444" }}
            title="Available Funds < 0: IBKR ไม่รับคำสั่งเปิด position ใหม่ที่เพิ่ม margin"
          >
            NO NEW POSITIONS
          </span>
        )}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="ml-auto text-[8px] px-1.5 border"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          {editing ? "CLOSE" : "SETTINGS"}
        </button>
      </div>

      {editing && (
        <SettingsForm initial={d.settings} colors={colors} onDone={() => setEditing(false)} />
      )}

      <CushionBar data={d} colors={colors} />

      <div className="grid gap-x-3 gap-y-0.5 text-[9px] tabular-nums grid-cols-2 sm:grid-cols-5">
        <Kpi label="NET LIQ" value={fmtAmt(d.nlv)} colors={colors} />
        <Kpi label="EQUITY W/ LOAN" value={fmtAmt(d.elv)} colors={colors} />
        <Kpi label="MAINT MARGIN" value={fmtAmt(d.maint_margin)} colors={colors} />
        <Kpi label="INITIAL MARGIN" value={fmtAmt(d.initial_margin)} colors={colors} />
        <Kpi
          label="EXCESS LIQUIDITY"
          value={fmtAmt(d.excess_liquidity)}
          color={d.excess_liquidity < 0 ? "#FF4444" : c}
          colors={colors}
        />
        <Kpi
          label="AVAILABLE FUNDS"
          value={fmtAmt(d.available_funds)}
          color={d.available_funds < 0 ? "#FF4444" : colors.text}
          colors={colors}
        />
        <Kpi
          label="LOAN (−CASH)"
          value={fmtAmt(d.loan)}
          color={d.loan > 0 ? "#FF9100" : colors.text}
          colors={colors}
        />
        <Kpi
          label="GROSS LEVERAGE"
          value={d.gross_leverage == null ? "—" : `${fmt(d.gross_leverage, 2)}×`}
          colors={colors}
        />
        <Kpi
          label="MARKET DROP → CALL"
          value={d.drop_to_call == null ? "ไม่ถึง" : `−${pct1(d.drop_to_call)}`}
          color={d.drop_to_call == null ? colors.text : c}
          title="ทุก underlying ลงพร้อมกันกี่ % ถึงจะ Excess Liquidity < 0 (option: time value คงที่)"
          colors={colors}
        />
        <Kpi
          label="RISE → CALL"
          value={d.rise_to_call == null ? "—" : `+${pct1(d.rise_to_call)}`}
          title="เฉพาะ book ที่มี short stock / short call"
          colors={colors}
        />
      </div>

      <div className="text-[8px]" style={{ color: colors.textSecondary }}>
        {ccy} · Cushion = EL / Net Liq · IBKR liquidates at EL &lt; 0
        {d.cash_is_estimate && (
          <span style={{ color: "#FF9100" }}>
            {" "}
            · ⚠ cash เป็นค่าประมาณ (derived) — reconcile ใน PORTFOLIO → CASH ให้ตรง statement IBKR
          </span>
        )}
        {d.missing.length > 0 && (
          <span style={{ color: "#FF9100" }}> · ⚠ {d.missing.join(" · ")}</span>
        )}
      </div>

      {d.assets.length > 0 && (
        <table className="w-full text-[9px] tabular-nums mt-1">
          <thead>
            <tr style={{ color: colors.textSecondary }}>
              {["", "UNDERLYING", "MV", "MAINT", "% OF MM", "ALONE ↓ CALL", "ALONE ↑ CALL"].map(
                (h, i) => (
                  <th
                    key={h || i}
                    className={`px-1 text-[7px] font-bold ${i > 1 ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {d.assets.map((a) => {
              const ac = LEVEL_COLOR[a.level];
              return (
                <tr key={a.key} style={{ borderTop: `1px solid ${colors.borderFaint}` }}>
                  <td
                    className="px-1"
                    style={{ color: ac }}
                    title={`${a.level}: ${LEVEL_TEXT[a.level]}`}
                  >
                    ●
                  </td>
                  <td className="px-1" style={{ color: colors.text }} title={a.symbols.join("\n")}>
                    {a.key}
                    {a.symbols.length > 1 && (
                      <span style={{ color: colors.textSecondary }}> ×{a.symbols.length}</span>
                    )}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.text }}>
                    {fmtAmt(a.mv)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.text }}>
                    {fmtAmt(a.maint)}
                  </td>
                  <td className="px-1 text-right" style={{ color: colors.textSecondary }}>
                    {pct1(a.mm_share)}
                  </td>
                  <td className="px-1 text-right font-bold" style={{ color: ac }}>
                    {a.drop_to_call == null ? "—" : `−${pct1(a.drop_to_call)}`}
                  </td>
                  <td className="px-1 text-right" style={{ color: ac }}>
                    {a.rise_to_call == null ? "—" : `+${pct1(a.rise_to_call)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <button
        type="button"
        onClick={() => setShowLines((v) => !v)}
        className="self-start text-[8px]"
        style={{ color: colors.textSecondary }}
      >
        {showLines ? "▾" : "▸"} requirement ราย position ({d.lines.length})
      </button>
      {showLines && (
        <table className="w-full text-[8.5px] tabular-nums">
          <thead>
            <tr style={{ color: colors.textSecondary }}>
              {["POSITION", "QTY", "PRICE", "MV", "RATE", "METHOD", "MAINT", "INITIAL"].map(
                (h, i) => (
                  <th
                    key={h}
                    className={`px-1 text-[7px] ${i > 0 && i !== 5 ? "text-right" : "text-left"}`}
                  >
                    {h}
                  </th>
                )
              )}
            </tr>
          </thead>
          <tbody>
            {d.lines.map((ln, i) => (
              <tr key={`${ln.symbol}-${i}`} style={{ color: colors.text }}>
                <td className="px-1">
                  <span style={{ color: LEVEL_COLOR[ln.level] }}>● </span>
                  {ln.symbol}
                </td>
                <td className="px-1 text-right">{fmtQty(ln.qty)}</td>
                <td className="px-1 text-right">{fmtPx(ln.price)}</td>
                <td className="px-1 text-right">{fmtAmt(ln.mv)}</td>
                <td className="px-1 text-right">
                  {ln.maint_rate == null ? "—" : pct1(ln.maint_rate)}
                </td>
                <td className="px-1" style={{ color: colors.textSecondary }}>
                  {ln.rate_source || "—"}
                </td>
                <td className="px-1 text-right">{fmtAmt(ln.maint)}</td>
                <td className="px-1 text-right">{fmtAmt(ln.initial)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="text-[7.5px] leading-snug" style={{ color: colors.textDimmed }}>
        Reg T: หุ้น long maint {pct1(d.settings.maint_long)} / initial {pct1(d.settings.initial)} ·
        short FINRA 4210 · short option ตามกฎ CBOE (covered → 0, spread → max loss, naked 20%/15%
        index) · long option ไม่มี loan value. ไม่รวม: SMA/เช็ค Reg T ตอนปิดตลาด, house margin ที่ IBKR
        ขึ้นเองรายตัว (ใส่ใน SETTINGS → overrides), portfolio margin, ดอกเบี้ย margin.
      </div>
    </>
  );
}

function Kpi({
  label,
  value,
  color,
  title,
  colors,
}: {
  label: string;
  value: string;
  color?: string;
  title?: string;
  colors: Colors;
}) {
  return (
    <div className="flex flex-col" title={title}>
      <span className="text-[7px] tracking-wider" style={{ color: colors.textSecondary }}>
        {label}
      </span>
      <span className="font-bold" style={{ color: color ?? colors.text }}>
        {value}
      </span>
    </div>
  );
}

/** Cushion on a 0–50% scale with the level floors marked. */
function CushionBar({ data, colors }: { data: MarginStatusOn; colors: Colors }) {
  const MAX = 0.5;
  const th = data.settings.thresholds;
  const x = (v: number) => `${(Math.min(Math.max(v, 0), MAX) / MAX) * 100}%`;
  const cushion = data.cushion ?? 0;
  const bands: [number, number, MarginLevel][] = [
    [0, th.DANGER, "DANGER"],
    [th.DANGER, th.WARNING, "WARNING"],
    [th.WARNING, th.WATCH, "WATCH"],
    [th.WATCH, MAX, "SAFE"],
  ];
  return (
    <div className="mt-0.5">
      <div className="relative h-2.5 w-full" style={{ background: colors.surfaceDeep }}>
        {bands.map(([a, b, lv]) => (
          <div
            key={lv}
            className="absolute top-0 h-full"
            style={{
              left: x(a),
              width: `calc(${x(b)} - ${x(a)})`,
              background: `${LEVEL_COLOR[lv]}33`,
            }}
          />
        ))}
        <div
          className="absolute top-[-2px] h-[14px] w-[3px]"
          style={{
            left: `calc(${x(cushion)} - 1px)`,
            background: LEVEL_COLOR[data.level],
            boxShadow: `0 0 4px ${LEVEL_COLOR[data.level]}`,
          }}
          title={`Cushion ${pct1(data.cushion)}`}
        />
      </div>
      <div className="relative h-3 text-[7px]" style={{ color: colors.textSecondary }}>
        {[0, th.DANGER, th.WARNING, th.WATCH, MAX].map((v) => (
          <span key={v} className="absolute -translate-x-1/2" style={{ left: x(v) }}>
            {Math.round(v * 100)}%
          </span>
        ))}
      </div>
      <div className="flex gap-2 text-[7px]" style={{ color: colors.textSecondary }}>
        {LEVEL_ORDER.map((lv) => (
          <span key={lv} style={{ color: lv === data.level ? LEVEL_COLOR[lv] : undefined }}>
            ● {lv}
          </span>
        ))}
        <span className="ml-auto" style={{ color: LEVEL_COLOR[data.level] }}>
          cushion {pct1(data.cushion)}
        </span>
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

const toPct = (v: number) => String(Math.round(v * 10000) / 100);

function SettingsForm({
  initial,
  colors,
  onDone,
}: {
  initial: MarginSettings;
  colors: Colors;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maintLong, setMaintLong] = useState(toPct(initial.maint_long));
  const [maintShort, setMaintShort] = useState(toPct(initial.maint_short));
  const [init, setInit] = useState(toPct(initial.initial));
  const [watch, setWatch] = useState(toPct(initial.thresholds.WATCH));
  const [warning, setWarning] = useState(toPct(initial.thresholds.WARNING));
  const [danger, setDanger] = useState(toPct(initial.thresholds.DANGER));
  const [overrides, setOverrides] = useState(
    Object.entries(initial.overrides)
      .map(([k, v]) => `${k}=${toPct(v)}`)
      .join("\n")
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const ov: Record<string, number> = {};
      for (const raw of overrides.split(/[\n,]/)) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^([^=\s]+)\s*=\s*([\d.]+)\s*%?$/);
        if (!m) throw new Error(`override อ่านไม่ออก: "${line}" (รูปแบบ SYMBOL=75)`);
        ov[m[1].toUpperCase()] = Number(m[2]) / 100;
      }
      await saveMarginSettings({
        scope: initial.scope,
        account_id: initial.account_id,
        enabled,
        maint_long: Number(maintLong) / 100,
        maint_short: Number(maintShort) / 100,
        initial: Number(init) / 100,
        overrides: ov,
        thresholds: {
          WATCH: Number(watch) / 100,
          WARNING: Number(warning) / 100,
          DANGER: Number(danger) / 100,
        },
      });
      await qc.invalidateQueries({ queryKey: ["margin"] });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = (label: string, v: string, set: (s: string) => void, title?: string) => (
    <label className="flex flex-col text-[7px] tracking-wider" title={title}>
      <span style={{ color: colors.textSecondary }}>{label}</span>
      <input
        value={v}
        onChange={(e) => set(e.target.value)}
        inputMode="decimal"
        className="w-16 px-1 text-[9px] tabular-nums bg-transparent border"
        style={{ borderColor: colors.border, color: colors.text }}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-1 p-1.5 my-1" style={{ background: colors.surfaceDeep }}>
      <label className="flex items-center gap-1 text-[9px]" style={{ color: colors.text }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        ใช้ margin (IBKR Reg T) กับบัญชีนี้
        {initial.scope === "paper" && (
          <span style={{ color: colors.textSecondary }}>
            {" "}
            — PAPER จะตรวจ buying power ตาม Reg T แทน cash
          </span>
        )}
      </label>
      <div className="flex flex-wrap gap-2">
        {input("LONG MAINT %", maintLong, setMaintLong, "IBKR Reg T: 25%")}
        {input("SHORT MAINT %", maintShort, setMaintShort, "FINRA 4210: 30% (≥$5)")}
        {input("INITIAL %", init, setInit, "Reg T: 50%")}
        <span className="w-2" />
        {input("WATCH < %", watch, setWatch, "cushion ต่ำกว่านี้ = WATCH")}
        {input("WARNING < %", warning, setWarning)}
        {input("DANGER < %", danger, setDanger)}
      </div>
      <label className="flex flex-col text-[7px] tracking-wider">
        <span style={{ color: colors.textSecondary }}>
          OVERRIDES — maint % รายตัว บรรทัดละ SYMBOL=% (เช่น TQQQ=75 ตาม house margin ใน statement
          IBKR)
        </span>
        <textarea
          value={overrides}
          onChange={(e) => setOverrides(e.target.value)}
          rows={2}
          className="px-1 text-[9px] bg-transparent border font-mono"
          style={{ borderColor: colors.border, color: colors.text }}
        />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="text-[9px] px-2 py-0.5 border font-bold"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          {busy ? "SAVING…" : "SAVE"}
        </button>
        {initial.scope === "port" && enabled && (
          <span className="text-[8px]" style={{ color: colors.textSecondary }}>
            บัญชีจะถูกตั้ง account_type = margin (cash ติดลบได้ใน accounting checks)
          </span>
        )}
        {err && (
          <span className="text-[8px]" style={{ color: "#FF4444" }}>
            {err}
          </span>
        )}
      </div>
    </div>
  );
}
