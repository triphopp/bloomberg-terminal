"use client";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { Colors } from "../helpers";

type Preview = {
  mode: "preview";
  entitlements?: {
    account_id: string;
    sub_account: string | null;
    asset: string;
    units: number;
    gross_amount: number;
    tax_withheld: number;
    total_received: number;
  }[];
  calculated_market_value?: number;
  difference?: number;
  currency?: string;
  O1?: boolean;
  O2?: boolean | null;
  quantity_differences?: { symbol: string; statement_qty: number; ledger_qty: number }[];
};

type StatementList = {
  statements: {
    statement: { id: string; as_of: string; source_ref: string; currency: string };
    comparison: {
      matched: boolean;
      cash_difference?: number | null;
      O2?: boolean;
      unavailable?: string;
    };
  }[];
};

let nextPositionRow = 0;
const blankPosition = () => ({ id: ++nextPositionRow, symbol: "", qty: "", cost: "", price: "" });

export function AccountingPreparePanel({
  accountId,
  colors,
}: { accountId: string; colors: Colors }) {
  const [mode, setMode] = useState<"dividend" | "opening">("dividend");
  const [symbol, setSymbol] = useState("");
  const [day, setDay] = useState("");
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState("");
  const [cash, setCash] = useState("");
  const [nav, setNav] = useState("");
  const [positions, setPositions] = useState(() => [blankPosition()]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sourceRef, setSourceRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const revision = useRef(0);
  const statements = useQuery<StatementList>({
    queryKey: ["broker-statements", accountId],
    enabled: accountId !== "all",
    queryFn: async () => {
      const r = await fetch(
        `/api/v2/portfolio/ledger/statements?account_id=${encodeURIComponent(accountId)}`
      );
      if (!r.ok) throw new Error(`Statement list HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });
  const inputStyle = { background: "#111", borderColor: colors.border, color: colors.text };
  const invalidate = () => {
    revision.current += 1;
    setPreview(null);
    setError("");
    setSaved("");
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    invalidate();
    const submittedRevision = revision.current;
    const body =
      mode === "dividend"
        ? {
            account_id: accountId,
            symbol,
            ex_date: day,
            amount_per_unit: Number(amount),
            tax_rate: Number(rate) / 100,
          }
        : {
            account_id: accountId,
            as_of: day,
            cash: Number(cash),
            market_value: Number(nav),
            positions: positions.map((p) => ({
              symbol: p.symbol,
              qty: Number(p.qty),
              cost_basis: Number(p.cost),
              market_price: Number(p.price),
            })),
          };
    try {
      const r = await fetch(
        `/api/v2/portfolio/ledger/${mode === "dividend" ? "prepare-dividend" : "check-opening"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const result = await r.json();
      if (!r.ok)
        throw new Error(
          typeof result.detail === "string" ? result.detail : "Check the entered values"
        );
      if (submittedRevision === revision.current) setPreview(result);
    } catch (err) {
      if (submittedRevision === revision.current)
        setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function recordStatement() {
    if (!preview?.O1 || !sourceRef.trim() || accountId === "all" || saving) return;
    const submittedRevision = revision.current;
    setSaving(true);
    setError("");
    const current = statements.data?.statements.find((item) => item.statement.as_of === day);
    try {
      const r = await fetch("/api/v2/portfolio/ledger/statements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          as_of: day,
          cash,
          market_value: nav,
          positions: positions.map((p) => ({
            symbol: p.symbol,
            qty: p.qty,
            cost_basis: p.cost,
            market_price: p.price,
          })),
          source_ref: sourceRef.trim(),
          supersedes_id: current?.statement.id ?? null,
        }),
      });
      const result = await r.json();
      if (!r.ok)
        throw new Error(
          typeof result.detail === "string" ? result.detail : "Statement save failed"
        );
      await statements.refetch();
      if (submittedRevision === revision.current) {
        setSaved(
          `Statement reference saved · ${result.comparison.matched ? "cash and quantities match the reconstruction; source not verified" : "differences need review"}`
        );
        setPreview(null);
      }
    } catch (err) {
      if (submittedRevision === revision.current)
        setError(err instanceof Error ? err.message : "Statement save failed");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="h-full overflow-auto px-4 py-3 text-[10px]" style={{ color: colors.text }}>
      <div className="flex gap-2 mb-3">
        {(["dividend", "opening"] as const).map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => {
              setMode(m);
              invalidate();
            }}
            className="border px-3 py-1"
            style={{
              borderColor: colors.border,
              color: mode === m ? colors.accent : colors.textSecondary,
            }}
          >
            {m === "dividend" ? "DIVIDEND ENTITLEMENT" : "OPENING BALANCE"}
          </button>
        ))}
      </div>
      <p className="mb-3" style={{ color: colors.textSecondary }}>
        PREVIEW · Check broker figures before recording. This form calculates a proposal without
        changing your accounts.
      </p>
      {accountId === "all" ? (
        <p>Select an account above to prepare its records.</p>
      ) : (
        <form
          key={`${accountId}-${mode}`}
          onSubmit={submit}
          onChange={invalidate}
          className="space-y-3 max-w-3xl"
        >
          <p>ACCOUNT · {accountId}</p>
          <label className="block">
            {mode === "dividend" ? "EX-DIVIDEND DATE" : "STATEMENT DATE"}
            <input
              required
              type="date"
              aria-label="Accounting date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="block border px-2 py-1 mt-1"
              style={inputStyle}
            />
          </label>
          {mode === "dividend" ? (
            <div className="flex flex-wrap gap-3">
              <label>
                SYMBOL
                <input
                  required
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  className="block border px-2 py-1 mt-1 w-28"
                  style={inputStyle}
                />
              </label>
              <label>
                GROSS PER UNIT
                <input
                  required
                  type="number"
                  min="0.000001"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="block border px-2 py-1 mt-1 w-28"
                  style={inputStyle}
                />
              </label>
              <label>
                BROKER WITHHOLDING %
                <input
                  required
                  type="number"
                  min="0"
                  max="99.99"
                  step="any"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  className="block border px-2 py-1 mt-1 w-28"
                  style={inputStyle}
                />
              </label>
            </div>
          ) : (
            <>
              <p style={{ color: colors.textSecondary }}>
                Enter all amounts in this account’s currency. Keep original cost separate from
                market value.
              </p>
              <div className="flex gap-3">
                <label>
                  CASH
                  <input
                    required
                    type="number"
                    step="any"
                    value={cash}
                    onChange={(e) => setCash(e.target.value)}
                    className="block border px-2 py-1 mt-1"
                    style={inputStyle}
                  />
                </label>
                <label>
                  TOTAL MARKET VALUE + CASH
                  <input
                    required
                    type="number"
                    step="any"
                    value={nav}
                    onChange={(e) => setNav(e.target.value)}
                    className="block border px-2 py-1 mt-1"
                    style={inputStyle}
                  />
                </label>
              </div>
              {positions.map((p, i) => (
                <div key={p.id} className="flex flex-wrap gap-2">
                  {(["symbol", "qty", "cost", "price"] as const).map((k) => (
                    <label key={k}>
                      {
                        {
                          symbol: "SYMBOL",
                          qty: "QUANTITY",
                          cost: "TOTAL COST BASIS",
                          price: "MARKET PRICE",
                        }[k]
                      }
                      <input
                        required
                        type={k === "symbol" ? "text" : "number"}
                        min="0"
                        step="any"
                        value={p[k]}
                        onChange={(e) =>
                          setPositions((old) =>
                            old.map((row, j) => (j === i ? { ...row, [k]: e.target.value } : row))
                          )
                        }
                        className="block border px-2 py-1 mt-1 w-28"
                        style={inputStyle}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    aria-label={`Remove position ${i + 1}`}
                    className="self-end border px-2 py-1"
                    style={{ borderColor: colors.border }}
                    onClick={() => {
                      setPositions((old) => old.filter((_, j) => j !== i));
                      invalidate();
                    }}
                  >
                    REMOVE
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="border px-2 py-1"
                style={{ borderColor: colors.border }}
                onClick={() => {
                  setPositions((p) => [...p, blankPosition()]);
                  invalidate();
                }}
              >
                ADD POSITION
              </button>
            </>
          )}
          <div>
            <button
              type="submit"
              disabled={loading}
              className="border px-3 py-1"
              style={{ borderColor: colors.accent, color: colors.accent }}
            >
              {loading ? "CHECKING…" : "CHECK PREVIEW"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-red-400">
          {error}
        </p>
      )}
      {preview && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: colors.border }}>
          {preview.entitlements && (
            <>
              <p className="mb-2">
                {preview.entitlements.length} entitled sub-account(s) · {preview.currency}
              </p>
              <table className="w-full text-left">
                <thead>
                  <tr>
                    {["SUB-ACCOUNT", "UNITS", "GROSS", "WITHHOLDING", "NET"].map((h) => (
                      <th key={h} className="p-1">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.entitlements.map((d) => (
                    <tr key={`${d.account_id}|${d.sub_account ?? ""}|${d.asset}`}>
                      {(
                        [
                          ["sub", d.sub_account || "unspecified"],
                          ["units", d.units],
                          ["gross", d.gross_amount],
                          ["tax", d.tax_withheld],
                          ["net", d.total_received],
                        ] as const
                      ).map(([col, v]) => (
                        <td key={col} className="p-1">
                          {typeof v === "number"
                            ? v.toLocaleString("en-US", { maximumFractionDigits: 6 })
                            : v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {preview.O1 != null && (
            <>
              <p>
                MARKET VALUE · {preview.currency}{" "}
                {preview.calculated_market_value?.toLocaleString()} · difference{" "}
                {preview.difference?.toLocaleString()} · {preview.O1 ? "MATCH" : "MISMATCH"}
              </p>
              <p className="mt-2">
                HOLDINGS · {preview.O2 == null ? "UNVERIFIED" : preview.O2 ? "MATCH" : "MISMATCH"}
              </p>
              {preview.quantity_differences?.map((p) => (
                <p key={p.symbol}>
                  {p.symbol}: statement {p.statement_qty} / recorded {p.ledger_qty}
                </p>
              ))}
              {preview.O1 && (
                <div
                  className="mt-3 border-t pt-3 space-y-2"
                  style={{ borderColor: colors.border }}
                >
                  <p style={{ color: colors.textSecondary }}>
                    Record a broker statement reference to compare cash and holdings later. This
                    saves evidence only.
                  </p>
                  <label className="block">
                    BROKER STATEMENT REFERENCE
                    <input
                      aria-label="Broker statement reference"
                      required
                      maxLength={256}
                      value={sourceRef}
                      onChange={(e) => setSourceRef(e.target.value)}
                      className="block border px-2 py-1 mt-1 w-72"
                      style={inputStyle}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!sourceRef.trim() || saving || statements.isLoading}
                    onClick={() => void recordStatement()}
                    className="border px-3 py-1 disabled:opacity-40"
                    style={{ borderColor: colors.accent, color: colors.accent }}
                  >
                    {saving ? "SAVING…" : "RECORD BROKER EVIDENCE"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {saved && <output className="block mt-3 text-green-400">{saved}</output>}
      {mode === "opening" && accountId !== "all" && (
        <div className="mt-4 border-t pt-3 space-y-1" style={{ borderColor: colors.border }}>
          <p>RECORDED BROKER STATEMENTS · {statements.data?.statements.length ?? 0}</p>
          {statements.isError && <p role="alert">Statement list unavailable.</p>}
          {statements.data?.statements.map(({ statement, comparison }) => (
            <p
              key={statement.id}
              style={{ color: comparison.matched ? colors.textSecondary : colors.accent }}
            >
              {statement.as_of} · {statement.source_ref} ·{" "}
              {comparison.unavailable
                ? `UNVERIFIABLE: ${comparison.unavailable}`
                : comparison.matched
                  ? "NUMBERS MATCH · SOURCE NOT VERIFIED"
                  : `REVIEW · cash difference ${comparison.cash_difference ?? "unknown"} ${statement.currency} · holdings ${comparison.O2 ? "match" : "differ"}`}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
