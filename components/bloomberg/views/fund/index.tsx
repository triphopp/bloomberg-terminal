"use client";

// FUND — the pooled fund ("กงสี"), a book of its own (plans/fund-book.md).
//
// Nothing here is ever summed into PORT: the fund's accounts carry a fund id
// and every figure is read with the scope `fund:<id>`. The band under the
// header says which book is on screen, and trades typed from this view carry
// that scope — the server refuses a fund trade typed anywhere else.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useAskContext } from "../../ask";
import { isDarkModeAtom } from "../../atoms";
import { bloombergColors } from "../../lib/theme-config";
import { type Colors, fmtAmt, fmtPx, fmtQty } from "../portfolio/helpers";
import { portfolioQueries } from "../portfolio/queries";
import { AnalyticsTab } from "../portfolio/tabs/AnalyticsTab";
import { ImportTab } from "../portfolio/tabs/ImportTab";
import { OpenPositionsTab } from "../portfolio/tabs/OpenPositionsTab";
import { RiskTab } from "../portfolio/tabs/RiskTab";
import { TradeLogTab } from "../portfolio/tabs/TradeLogTab";
import type { Summary } from "../portfolio/types";
import { DepositsPage } from "./DepositsPage";
import { type Ccy, type FundDetail, type MembersView, displayRate, fundApi, num } from "./api";

type Page =
  | "members"
  | "deposits"
  | "holdings"
  | "trades"
  | "entry"
  | "analytics"
  | "risk"
  | "setup";
const PAGES: { id: Page; label: string }[] = [
  { id: "members", label: "MEMBERS" },
  { id: "deposits", label: "DEPOSITS" },
  { id: "holdings", label: "HOLDINGS" },
  { id: "trades", label: "TRADES" },
  { id: "entry", label: "ENTRY" },
  { id: "analytics", label: "ANALYTICS" },
  { id: "risk", label: "RISK" },
  { id: "setup", label: "SETUP" },
];
const FUND_KEY = "bloomberg_fund_selected";
const SHOWN_KEY = "bloomberg_fund_currency";

// `rate` turns the fund's base currency into the one on screen (1 = the same,
// null = today's rate is unknown, so nothing is shown rather than a wrong figure).
const money = (v: string | null | undefined, rate: number | null = 1) => {
  const n = num(v);
  return n == null || rate == null ? "—" : fmtAmt(n * rate);
};
const units = (v: string | null | undefined) => {
  const n = num(v);
  return n == null ? "—" : fmtQty(n);
};
const pct = (v: string | null | undefined) => {
  const n = num(v);
  return n == null ? "—" : `${n.toFixed(2)}%`;
};

export function FundView() {
  const [isDarkMode] = useAtom(isDarkModeAtom);
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  const qc = useQueryClient();
  const [page, setPage] = useState<Page>("members");
  const [fundId, setFundId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try {
      return localStorage.getItem(FUND_KEY) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FUND_KEY, fundId);
    } catch {
      /* private window: the choice lasts for this visit */
    }
  }, [fundId]);

  // The currency figures are SHOWN in. The fund's own currency never changes:
  // units, shares and every stored amount stay in it. "" = the fund's own.
  const [shownPref, setShownPref] = useState<Ccy | "">(() => {
    if (typeof window === "undefined") return "";
    try {
      const v = localStorage.getItem(SHOWN_KEY);
      return v === "THB" || v === "USD" ? v : "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SHOWN_KEY, shownPref);
    } catch {
      /* private window */
    }
  }, [shownPref]);

  const fundsQ = useQuery({ queryKey: ["fund", "list"], queryFn: fundApi.list, staleTime: 60_000 });
  const funds = fundsQ.data?.funds ?? [];
  const active = funds.find((f) => f.id === fundId) ?? funds[0];
  const id = active?.id ?? "";

  const detailQ = useQuery({
    queryKey: ["fund", id, "detail"],
    queryFn: () => fundApi.detail(id),
    enabled: !!id,
    staleTime: 30_000,
  });
  const membersQ = useQuery({
    queryKey: ["fund", id, "members"],
    queryFn: () => fundApi.members(id),
    enabled: !!id,
    staleTime: 30_000,
  });
  // The fund's own summary (its accounts only) for the ANALYTICS page.
  const summaryQ = useQuery({
    ...portfolioQueries.summary(
      shownPref || active?.base_currency || "THB",
      id ? `fund:${id}` : undefined
    ),
    enabled: !!id && page === "analytics",
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["fund"] });
    qc.invalidateQueries({ queryKey: ["portfolio"] });
  };

  const detail = detailQ.data;
  const scope = detail?.scope ?? (id ? `fund:${id}` : "");
  useAskContext({
    note: active
      ? `FUND view — the pooled fund "${active.name}", a book separate from the personal portfolio (page ${page})`
      : "FUND view — no fund has been created yet",
  });

  if (fundsQ.isLoading) return <Shell colors={colors}>กำลังโหลด…</Shell>;
  if (fundsQ.error)
    return <Shell colors={colors}>โหลดรายชื่อกองทุนไม่ได้: {(fundsQ.error as Error).message}</Shell>;
  if (!active)
    return (
      <Shell colors={colors}>
        <CreateFund
          colors={colors}
          onCreated={(f) => {
            setFundId(f);
            refresh();
          }}
        />
      </Shell>
    );

  const base = active.base_currency;
  const shown: Ccy = shownPref || base;
  const summary = (summaryQ.data as Summary | undefined) ?? null;
  const thbPerUsd = detail?.value.thb_per_usd ?? membersQ.data?.value.thb_per_usd ?? null;
  const rate = displayRate(base, shown, thbPerUsd);
  return (
    <div className="flex flex-col h-full" style={{ background: "#000", color: colors.text }}>
      {/* The band: which book is on screen. Blue, where PORT has none. */}
      <div
        className="shrink-0 flex flex-wrap items-center gap-x-3 px-2 py-1 border-b text-[10px] font-bold"
        style={{ background: colors.accentBlue, color: "#000", borderColor: colors.border }}
      >
        <span>กองทุน</span>
        {funds.length > 1 ? (
          <select
            value={id}
            onChange={(e) => setFundId(e.target.value)}
            className="text-[10px] font-bold px-1"
            style={{ background: "#000", color: colors.accentBlue }}
          >
            {funds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        ) : (
          <span>{active.name.toUpperCase()}</span>
        )}
        <span className="font-normal">สมุดแยกจากพอร์ตส่วนตัว · ไม่ถูกรวมใน PORT</span>
        <span className="ml-auto flex items-center gap-1 font-normal">
          <span>สกุลเงินของกอง {base} · แสดงเป็น</span>
          {(["THB", "USD"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={shown === c}
              onClick={() => setShownPref(c)}
              className="px-1 font-bold"
              style={
                shown === c ? { background: "#000", color: colors.accentBlue } : { color: "#000" }
              }
            >
              {c}
            </button>
          ))}
        </span>
      </div>

      <ValueStrip
        colors={colors}
        detail={detail}
        members={membersQ.data}
        shown={shown}
        rate={rate}
      />
      {shown !== base && (
        <div
          className="shrink-0 px-2 py-0.5 text-[10px] border-b"
          style={{ borderColor: colors.border, color: colors.accentWarn }}
        >
          {rate == null
            ? `ไม่มีอัตราแลกเปลี่ยนของวันนี้ จึงแสดงเป็น ${shown} ไม่ได้`
            : `แสดงเป็น ${shown} ด้วยอัตราวันนี้ (${fmtAmt(thbPerUsd ?? 0)} บาทต่อ 1 USD) ทุกตัวเลขรวมถึงเงินต้น · ตัวเลขที่บันทึก หน่วย และสัดส่วนยังคิดเป็น ${base}`}
        </div>
      )}

      <div
        className="shrink-0 flex items-center border-b px-1"
        style={{ borderColor: colors.border, background: "#080808" }}
      >
        {PAGES.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={page === p.id}
            onClick={() => setPage(p.id)}
            className="text-[10px] px-2 py-1 font-bold hover:opacity-80"
            style={{ color: page === p.id ? colors.accent : colors.textSecondary }}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={refresh}
          className="ml-auto text-[9px] px-2 py-1 hover:opacity-80"
          style={{ color: colors.textSecondary }}
        >
          REFRESH
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {page === "members" && (
          <MembersPage
            colors={colors}
            fundId={id}
            view={membersQ.data}
            loading={membersQ.isLoading}
            error={membersQ.error as Error | null}
            rate={rate}
            onChanged={refresh}
          />
        )}
        {page === "deposits" && detail && (
          <DepositsPage
            colors={colors}
            fund={detail}
            members={membersQ.data?.members ?? []}
            onChanged={refresh}
            onOpenEntry={() => setPage("entry")}
          />
        )}
        {page === "holdings" && scope && (
          <OpenPositionsTab
            accountId={scope}
            currency={shown}
            colors={colors}
            onOpenThesis={() => {}}
          />
        )}
        {page === "trades" && scope && (
          <TradeLogTab accountId={scope} currency={shown} colors={colors} />
        )}
        {page === "entry" &&
          scope &&
          (detail && detail.accounts.length === 0 ? (
            <Note colors={colors}>กองนี้ยังไม่มีบัญชีโบรก เพิ่มบัญชีในหน้า SETUP ก่อนจึงบันทึกการซื้อขายได้</Note>
          ) : (
            <ImportTab colors={colors} variant="manual" book={scope} />
          ))}
        {/* PORT's own screens, given the fund's scope: every figure is the
            fund's alone (backend/account_scope.py). */}
        {page === "analytics" && scope && (
          <AnalyticsTab accountId={scope} currency={shown} summary={summary} colors={colors} />
        )}
        {page === "risk" && scope && <RiskTab accountId={scope} currency={shown} colors={colors} />}
        {page === "setup" && detail && (
          <SetupPage colors={colors} detail={detail} onChanged={refresh} />
        )}
        {page !== "members" && !detail && detailQ.isLoading && (
          <Note colors={colors}>กำลังโหลด…</Note>
        )}
      </div>
    </div>
  );
}

function Shell({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col h-full p-3 text-[11px]"
      style={{ background: "#000", color: colors.text }}
    >
      {children}
    </div>
  );
}

function Note({ colors, children }: { colors: Colors; children: React.ReactNode }) {
  return (
    <div className="p-3 text-[11px]" style={{ color: colors.textSecondary }}>
      {children}
    </div>
  );
}

function Cell({
  label,
  value,
  colors,
  title,
}: { label: string; value: string; colors: Colors; title?: string }) {
  return (
    <div className="flex flex-col px-2 py-1" title={title}>
      <span className="text-[9px]" style={{ color: colors.textSecondary }}>
        {label}
      </span>
      <span className="text-[12px] font-bold tabular-nums">{value}</span>
    </div>
  );
}

function ValueStrip({
  colors,
  detail,
  members,
  shown,
  rate,
}: {
  colors: Colors;
  detail?: FundDetail;
  members?: MembersView;
  shown: Ccy;
  rate: number | null;
}) {
  const v = detail?.value;
  const basePrice = num(members?.unit_price);
  const price = basePrice == null || rate == null ? null : basePrice * rate;
  return (
    <div className="shrink-0 border-b" style={{ borderColor: colors.border }}>
      <div className="flex flex-wrap items-stretch">
        <Cell
          colors={colors}
          label={`มูลค่ากอง (${shown})`}
          value={money(v?.nav, rate)}
          title="ของที่ถือตามราคาตลาด + options + เงินสด"
        />
        <Cell colors={colors} label="ของที่ถือ" value={money(v?.holdings, rate)} />
        <Cell
          colors={colors}
          label={v?.cash_is_estimate ? "เงินสด (ประมาณ)" : "เงินสด"}
          value={money(v?.cash, rate)}
        />
        <Cell colors={colors} label="เงินต้นรวม" value={money(detail?.capital, rate)} />
        <Cell colors={colors} label="หน่วยทั้งหมด" value={units(detail?.units)} />
        <Cell
          colors={colors}
          label="ราคาต่อหน่วย"
          value={price == null ? "—" : fmtPx(price)}
          title="มูลค่ากอง ÷ หน่วยทั้งหมด — ตัววัดผลงานของกอง"
        />
        <Cell
          colors={colors}
          label="กติกาแบ่งผล"
          value={
            detail?.split_rule?.basis === "CAPITAL"
              ? "ตามเงินต้น"
              : (detail?.split_rule?.basis ?? "—")
          }
          title={detail?.split_rule ? `เริ่มใช้ ${detail.split_rule.effective_from}` : undefined}
        />
      </div>
      {v && v.unpriced.length > 0 && (
        <div className="px-2 py-1 text-[10px]" style={{ color: colors.accentWarn }}>
          ตีมูลค่ากองไม่ได้: ไม่มีราคาของ {v.unpriced.join(", ")} — ราคาต่อหน่วยและมูลค่าของสมาชิกจึงว่าง
          และการรับเงินเข้าต้องกรอกราคาต่อหน่วยเองพร้อมเหตุผล
        </div>
      )}
    </div>
  );
}

function MembersPage({
  colors,
  fundId,
  view,
  loading,
  error,
  rate,
  onChanged,
}: {
  colors: Colors;
  fundId: string;
  view?: MembersView;
  loading: boolean;
  error: Error | null;
  rate: number | null;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      await fundApi.addMember(fundId, { name });
      setName("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const th = "text-right px-2 py-1 font-normal";
  const td = "text-right px-2 py-1 tabular-nums";
  if (loading) return <Note colors={colors}>กำลังโหลด…</Note>;
  if (error) return <Note colors={colors}>โหลดสมาชิกไม่ได้: {error.message}</Note>;
  const rows = view?.members ?? [];
  return (
    <div className="p-2 text-[11px]">
      <div className="mb-1 text-[10px]" style={{ color: colors.textSecondary }}>
        ผลของกองแบ่งตาม <b style={{ color: colors.text }}>สัดส่วนเงินต้น</b> · สัดส่วนตามหน่วยแสดงไว้เทียบ
        (หน่วย = เงินที่ลง ÷ ราคาต่อหน่วยของวันที่ลง)
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr style={{ color: colors.textSecondary, borderBottom: `1px solid ${colors.border}` }}>
            <th className="text-left px-2 py-1 font-normal">สมาชิก</th>
            <th className={th}>เงินต้น</th>
            <th className={th}>% เงินต้น</th>
            <th className={th}>มูลค่าตามเงินต้น</th>
            <th className={th}>หน่วย</th>
            <th className={th}>% หน่วย</th>
            <th className={th}>มูลค่าตามหน่วย</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} style={{ borderBottom: `1px solid ${colors.borderFaint}` }}>
              <td className="px-2 py-1">{m.name}</td>
              <td className={td}>{money(m.capital, rate)}</td>
              <td className={td} style={{ color: colors.accent }}>
                {pct(m.capital_share_pct)}
              </td>
              <td className={td}>{money(m.value_by_capital, rate)}</td>
              <td className={td} style={{ color: colors.textSecondary }}>
                {units(m.units)}
              </td>
              <td className={td} style={{ color: colors.textSecondary }}>
                {pct(m.units_share_pct)}
              </td>
              <td className={td} style={{ color: colors.textSecondary }}>
                {money(m.value_by_units, rate)}
              </td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr style={{ color: colors.textSecondary }}>
              <td className="px-2 py-1">รวม</td>
              <td className={td}>{money(view?.capital_total, rate)}</td>
              <td className={td} />
              <td className={td}>{money(view?.nav, rate)}</td>
              <td className={td}>{units(view?.units_total)}</td>
              <td className={td} />
              <td className={td}>{money(view?.nav, rate)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length === 0 && <Note colors={colors}>ยังไม่มีสมาชิก เพิ่มคนแรกด้านล่าง</Note>}
      <div className="mt-3 flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ชื่อสมาชิกใหม่"
          className="px-2 py-1 text-[11px] border bg-transparent"
          style={{ borderColor: colors.border, color: colors.text }}
        />
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={add}
          className="px-2 py-1 text-[10px] font-bold border disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          + เพิ่มสมาชิก
        </button>
        {err && <span style={{ color: colors.negative }}>{err}</span>}
      </div>
    </div>
  );
}

function CreateFund({ colors, onCreated }: { colors: Colors; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [base, setBase] = useState("THB");
  const [par, setPar] = useState("10");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const create = async () => {
    setBusy(true);
    setErr("");
    try {
      const f = await fundApi.create({ name, base_currency: base, unit_par: par });
      onCreated(f.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const input = "px-2 py-1 text-[11px] border bg-transparent";
  return (
    <div className="max-w-xl">
      <div className="text-[12px] font-bold mb-1" style={{ color: colors.accentBlue }}>
        สร้างกองทุน
      </div>
      <p className="mb-2" style={{ color: colors.textSecondary }}>
        กองทุนเป็นสมุดของตัวเอง เริ่มจากศูนย์ ไม่มีตัวเลขใดถูกรวมกับพอร์ตส่วนตัว
        ก่อนสร้างกองแรกทุกเครื่องที่ใช้ระบบนี้ต้องอัปเดตโค้ดแล้ว (เครื่องที่ยังเป็นโค้ดเก่าจะมองบัญชีกองทุนเป็นบัญชีส่วนตัว)
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span style={{ color: colors.textSecondary }}>ชื่อกอง</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
            style={{ borderColor: colors.border, color: colors.text }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: colors.textSecondary }}>สกุลเงินของกอง</span>
          <select
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className={input}
            style={{ borderColor: colors.border }}
          >
            <option value="THB">THB</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: colors.textSecondary }}>ราคาต่อหน่วยเริ่มต้น</span>
          <input
            value={par}
            onChange={(e) => setPar(e.target.value)}
            className={`${input} w-24`}
            style={{ borderColor: colors.border, color: colors.text }}
          />
        </label>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={create}
          className="px-3 py-1 text-[10px] font-bold border disabled:opacity-40"
          style={{ borderColor: colors.accentBlue, color: colors.accentBlue }}
        >
          สร้างกอง
        </button>
      </div>
      {err && (
        <div className="mt-2" style={{ color: colors.negative }}>
          {err}
        </div>
      )}
    </div>
  );
}

function SetupPage({
  colors,
  detail,
  onChanged,
}: { colors: Colors; detail: FundDetail; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("THB");
  const [broker, setBroker] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // The id is what trades are stored under; derived from the name, shown before it is used.
  const accountId = useMemo(
    () =>
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    [name]
  );
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      await fundApi.addAccount(detail.id, { id: accountId, name, currency, broker });
      setName("");
      setBroker("");
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const input = "px-2 py-1 text-[11px] border bg-transparent";
  const head = "text-[10px] font-bold mt-3 mb-1";
  return (
    <div className="p-2 text-[11px] max-w-3xl">
      <div className={head} style={{ color: colors.accent }}>
        บัญชีโบรกของกอง
      </div>
      {detail.accounts.length === 0 && <div style={{ color: colors.textSecondary }}>ยังไม่มีบัญชี</div>}
      {detail.accounts.map((a) => (
        <div key={a.id} className="flex gap-3 py-0.5">
          <span className="font-bold">{a.name}</span>
          <span style={{ color: colors.textSecondary }}>
            {a.id} · {a.currency}
            {a.broker ? ` · ${a.broker}` : ""}
          </span>
        </div>
      ))}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span style={{ color: colors.textSecondary }}>ชื่อบัญชี (อังกฤษ)</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
            style={{ borderColor: colors.border, color: colors.text }}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: colors.textSecondary }}>สกุลเงิน</span>
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className={input}
            style={{ borderColor: colors.border }}
          >
            <option value="THB">THB</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: colors.textSecondary }}>โบรกเกอร์</span>
          <input
            value={broker}
            onChange={(e) => setBroker(e.target.value)}
            className={input}
            style={{ borderColor: colors.border, color: colors.text }}
          />
        </label>
        <button
          type="button"
          disabled={busy || !accountId}
          onClick={add}
          className="px-2 py-1 text-[10px] font-bold border disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent }}
        >
          + เพิ่มบัญชี
        </button>
        {accountId && <span style={{ color: colors.textSecondary }}>รหัสบัญชี: {accountId}</span>}
      </div>
      <div className="mt-1" style={{ color: colors.textSecondary }}>
        บัญชีของกองเป็นบัญชีใหม่เสมอ บัญชีส่วนตัวที่มีอยู่ย้ายเข้ากองไม่ได้
      </div>
      {err && (
        <div className="mt-1" style={{ color: colors.negative }}>
          {err}
        </div>
      )}

      <div className={head} style={{ color: colors.accent }}>
        กติกาแบ่งผล
      </div>
      <div>
        {detail.split_rule
          ? `ตามสัดส่วนเงินต้น ณ วันแบ่ง ไม่ถ่วงเวลา — เริ่มใช้ ${detail.split_rule.effective_from}`
          : "ยังไม่ได้ตั้ง"}
      </div>

      <div className={head} style={{ color: colors.accent }}>
        ยังไม่ได้ตั้ง
      </div>
      <ul style={{ color: colors.textSecondary }}>
        <li>นโยบายการลงทุน (Policy) — ระบบยังไม่ตรวจกฎใด</li>
        <li>การถอนเงินของสมาชิก — ยังไม่มีในระบบ</li>
        <li>การแบ่งผล (จ่ายออก / ทบต้น) — ยังไม่มีในระบบ</li>
        <li>ข้อตกลงเป็นลายลักษณ์อักษร และชื่อบัญชีโบรก — ยังไม่ได้บันทึก</li>
      </ul>
    </div>
  );
}
