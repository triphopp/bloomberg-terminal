"use client";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { Colors } from "../helpers";
import type { AuditEvent } from "../types";
import { AccountingChecksPanel } from "../ui/AccountingChecksPanel";
import { AccountingPreparePanel } from "../ui/AccountingPreparePanel";

const TABLES: { id: string; label: string }[] = [
  { id: "", label: "ALL" },
  { id: "trades", label: "TRADES" },
  { id: "broker_executions", label: "BROKER FILLS" },
  { id: "option_trades", label: "OPTIONS" },
  { id: "cash_ledger", label: "CASH" },
  { id: "cash_adjustments", label: "CASH EDIT" },
  { id: "dividends", label: "DIVIDENDS" },
  { id: "position_cost_overrides", label: "AVG COST" },
  { id: "portfolio_accounts", label: "ACCOUNTS" },
  { id: "allocation_targets", label: "TARGETS" },
  { id: "option_contracts", label: "CONTRACTS" },
  { id: "transactions", label: "LEGACY TX" },
];

const TABLE_LABEL = Object.fromEntries(TABLES.filter((t) => t.id).map((t) => [t.id, t.label]));

const ACTION_COLOR: Record<AuditEvent["action"], string> = {
  INSERT: "#4ade80",
  UPDATE: "#facc15",
  DELETE: "#f87171",
};

// Fields that name the row, so a line reads "PTT" rather than a uuid.
const LABEL_FIELDS = ["symbol", "asset", "name", "key", "note"];
const AMOUNT_FIELDS = ["amount", "investment", "income", "total_received", "avg_cost", "price"];

const fmtVal = (v: unknown) => {
  if (v === null || v === undefined || v === "") return "∅";
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "");
  const s = String(v);
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
};

function describe(e: AuditEvent): string {
  const row = e.new ?? e.old ?? {};
  const label = LABEL_FIELDS.map((f) => row[f]).find(
    (v) => v !== null && v !== undefined && v !== ""
  );
  if (e.action === "UPDATE" && e.changed) {
    const parts = Object.entries(e.changed).map(
      ([k, { old, new: nv }]) => `${k}: ${fmtVal(old)} → ${fmtVal(nv)}`
    );
    return `${label ? `${fmtVal(label)} · ` : ""}${parts.join(" · ")}`;
  }
  if (e.table_name === "broker_executions") {
    return `${String(row.symbol)} ${String(row.side)} ${String(row.quantity)} @ ${String(row.unit_price)} ${String(row.instrument_ccy)} · ${String(row.executed_at_local).replace("T", " ")}`;
  }
  const amounts = AMOUNT_FIELDS.filter((f) => typeof row[f] === "number" && row[f] !== 0).map(
    (f) => `${f} ${fmtVal(row[f])}`
  );
  return [label ? fmtVal(label) : e.row_id.slice(0, 12), ...amounts].join(" · ");
}

/**
 * Every change to a money table, newest first. Written by SQLite triggers, so
 * nothing that touches trades, cash, dividends or accounts can skip it —
 * including imports and sells. Deleted rows stay readable here.
 */
export function AuditTab({ accountId, colors }: { accountId: string; colors: Colors }) {
  const [mode, setMode] = useState<"events" | "checks" | "prepare">("checks");
  const [table, setTable] = useState("");
  const [action, setAction] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ limit: "200" });
      if (accountId !== "all") qs.set("account_id", accountId);
      if (table) qs.set("table_name", table);
      if (action) qs.set("action", action);
      if (before) qs.set("before", before);
      try {
        const r = await fetch(`/api/v2/portfolio/audit-events?${qs}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d: { events: AuditEvent[]; next_before: string | null } = await r.json();
        setEvents((prev) => (before ? [...prev, ...d.events] : d.events));
        setNext(d.next_before);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Load failed");
      } finally {
        setLoading(false);
      }
    },
    [accountId, table, action]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const chip = (active: boolean) => ({
    borderColor: active ? colors.accent : colors.border,
    color: active ? colors.accent : colors.textSecondary,
  });

  return (
    <div className="h-full flex flex-col overflow-hidden font-mono">
      <div
        className="shrink-0 flex gap-2 px-3 py-2 border-b text-[10px]"
        style={{ borderColor: colors.border }}
      >
        {(["checks", "prepare", "events"] as const).map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => setMode(m)}
            className="border px-2 py-1"
            style={chip(mode === m)}
          >
            {m === "checks"
              ? "ACCOUNTING CHECK"
              : m === "prepare"
                ? "PREPARE RECORDS"
                : "CHANGE LOG"}
          </button>
        ))}
      </div>
      {mode === "checks" ? (
        <div className="flex-1 min-h-0">
          <AccountingChecksPanel accountId={accountId} colors={colors} />
        </div>
      ) : mode === "prepare" ? (
        <div className="flex-1 min-h-0">
          <AccountingPreparePanel key={accountId} accountId={accountId} colors={colors} />
        </div>
      ) : (
        <>
          <div
            className="shrink-0 flex flex-wrap items-center gap-1 px-3 py-1.5 border-b text-[9px]"
            style={{ borderColor: colors.border }}
          >
            {TABLES.map((t) => (
              <button
                key={t.id || "all"}
                type="button"
                onClick={() => setTable(t.id)}
                className="px-1.5 py-0.5 border"
                style={chip(table === t.id)}
              >
                {t.label}
              </button>
            ))}
            <span className="mx-1" style={{ color: colors.border }}>
              |
            </span>
            {["", "INSERT", "UPDATE", "DELETE"].map((a) => (
              <button
                key={a || "any"}
                type="button"
                onClick={() => setAction(a)}
                className="px-1.5 py-0.5 border"
                style={chip(action === a)}
              >
                {a || "ANY"}
              </button>
            ))}
            <button
              type="button"
              onClick={() => load()}
              disabled={loading}
              className="ml-auto p-1 hover:opacity-70"
              title="Reload"
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" style={{ color: colors.accent }} />
              ) : (
                <RefreshCw className="h-3 w-3" style={{ color: colors.textSecondary }} />
              )}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {error && (
              <div className="px-3 py-2 text-[10px]" style={{ color: "#f87171" }}>
                {error}
              </div>
            )}
            {!loading && !error && events.length === 0 && (
              <div
                className="px-3 py-6 text-[10px] text-center"
                style={{ color: colors.textSecondary }}
              >
                No changes recorded yet. Every add, edit and delete from now on appears here.
              </div>
            )}
            <table className="w-full text-[9px]">
              <tbody>
                {events.map((e) => {
                  const expanded = open === e.event_id;
                  return (
                    <Fragment key={e.event_id}>
                      <tr
                        className="border-b cursor-pointer hover:bg-white/5"
                        style={{ borderColor: `${colors.border}66` }}
                        tabIndex={0}
                        onClick={() => setOpen(expanded ? null : e.event_id)}
                        onKeyDown={(k) => {
                          if (k.key === "Enter" || k.key === " ")
                            setOpen(expanded ? null : e.event_id);
                        }}
                      >
                        <td className="pl-2 w-3">
                          {expanded ? (
                            <ChevronDown
                              className="h-2.5 w-2.5"
                              style={{ color: colors.textSecondary }}
                            />
                          ) : (
                            <ChevronRight
                              className="h-2.5 w-2.5"
                              style={{ color: colors.textSecondary }}
                            />
                          )}
                        </td>
                        <td
                          className="px-2 py-1 whitespace-nowrap"
                          style={{ color: colors.textSecondary }}
                        >
                          {e.created_at.slice(0, 19)}
                        </td>
                        <td className="px-1 font-bold" style={{ color: ACTION_COLOR[e.action] }}>
                          {e.action}
                        </td>
                        <td className="px-1 whitespace-nowrap" style={{ color: colors.accent }}>
                          {TABLE_LABEL[e.table_name] ?? e.table_name}
                        </td>
                        <td
                          className="px-1 whitespace-nowrap"
                          style={{ color: colors.textSecondary }}
                        >
                          {e.account_id ?? ""}
                        </td>
                        <td className="px-1 w-full" style={{ color: colors.text }}>
                          {describe(e)}
                        </td>
                        <td className="px-2 whitespace-nowrap italic" style={{ color: "#c084fc" }}>
                          {e.reason ?? ""}
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={7} className="px-6 py-2" style={{ background: "#0d0d0d" }}>
                            <div className="overflow-x-auto">
                              <table className="text-[9px]">
                                <thead>
                                  <tr style={{ color: colors.textSecondary }}>
                                    <th className="text-left pr-4">FIELD</th>
                                    <th className="text-left pr-4">BEFORE</th>
                                    <th className="text-left">AFTER</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {Object.keys({ ...(e.old ?? {}), ...(e.new ?? {}) }).map((k) => {
                                    const before = e.old?.[k];
                                    const after = e.new?.[k];
                                    const diff = e.action === "UPDATE" && before !== after;
                                    return (
                                      <tr key={k} style={{ color: diff ? "#facc15" : colors.text }}>
                                        <td
                                          className="pr-4"
                                          style={{ color: colors.textSecondary }}
                                        >
                                          {k}
                                        </td>
                                        <td className="pr-4">
                                          {e.old ? String(before ?? "∅") : ""}
                                        </td>
                                        <td>{e.new ? String(after ?? "∅") : ""}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              <div className="mt-1" style={{ color: "#555" }}>
                                row {e.row_id} · event {e.event_id}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {next && (
              <button
                type="button"
                onClick={() => load(next)}
                disabled={loading}
                className="w-full py-2 text-[9px] border-t"
                style={{ borderColor: colors.border, color: colors.accent }}
              >
                LOAD OLDER
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
