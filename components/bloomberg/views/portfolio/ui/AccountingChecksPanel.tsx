"use client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { AccountingReport } from "../accounting-types";
import type { Colors } from "../helpers";
import { StockCardModal } from "../modals/StockCardModal";

export function AccountingChecksPanel({
  accountId,
  colors,
}: { accountId: string; colors: Colors }) {
  const [severity, setSeverity] = useState("");
  const [card, setCard] = useState<{ accountId: string; symbol: string } | null>(null);
  const { data, error, isFetching, refetch } = useQuery<AccountingReport>({
    queryKey: ["portfolio-accounting-checks", accountId],
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams();
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/ledger/check?${qs}`, { signal });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || "Accounting checks failed");
      return body;
    },
    staleTime: 30_000,
  });
  const findings = data?.findings.filter((f) => !severity || f.severity === severity) ?? [];
  return (
    <div className="h-full flex flex-col overflow-hidden text-[10px]">
      <div
        className="shrink-0 flex flex-wrap items-center gap-3 px-3 py-2 border-b"
        style={{ borderColor: colors.border }}
      >
        {(["", "error", "warn", "info"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSeverity(s)}
            className="border px-2 py-1"
            style={{ borderColor: severity === s ? colors.accent : colors.border }}
          >
            {s.toUpperCase() || "ALL"}
            {s && data ? ` ${data.counts[s]}` : ""}
          </button>
        ))}
        <span style={{ color: colors.textSecondary }}>
          {data?.events ?? "—"} reconstructed events · {data?.posted_events ?? "—"} posted
        </span>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="ml-auto border px-2 py-1"
          style={{ borderColor: colors.border }}
        >
          {isFetching ? "CHECKING…" : "RECHECK"}
        </button>
      </div>
      {error && (
        <p role="alert" className="p-3 text-red-400">
          {error.message}
        </p>
      )}
      <div className="flex-1 min-h-0 overflow-auto">
        {data && (
          <div className="p-3" style={{ color: colors.textSecondary }}>
            <p style={{ color: data.ready_for_read_switch ? "#4ade80" : "#fbbf24" }}>
              {data.ready_for_read_switch ? "READY FOR READ SWITCH" : "READ SWITCH BLOCKED"} ·{" "}
              {data.read_switch_reason}
            </p>
            <div className="mt-2 grid gap-1" aria-label="Read switch requirements">
              {data.read_switch_gates.map((gate) => (
                <p key={gate.id}>
                  {gate.id.toUpperCase().replaceAll("_", " ")} · {gate.status.toUpperCase()} ·{" "}
                  {gate.reason}
                  {gate.missing_account_ids?.length
                    ? ` Missing: ${gate.missing_account_ids.join(", ")}`
                    : ""}
                </p>
              ))}
            </div>
            {data.checks
              .filter((c) => c.status !== "checked")
              .map((c) => (
                <p key={c.code} className="mt-1">
                  {c.code} · {c.status.toUpperCase()} · {c.reason}
                </p>
              ))}
          </div>
        )}
        {data && findings.length === 0 && (
          <p className="px-3 py-4">
            No findings for this filter. See checks above for any incomplete verification.
          </p>
        )}
        <table className="w-full">
          <thead className="sticky top-0 bg-[#111]">
            <tr>
              {["LEVEL", "CHECK", "ACCOUNT", "SYMBOL", "FINDING"].map((h) => (
                <th key={h} className="text-left p-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {findings.map((f, i) => (
              <tr
                key={`${f.code}-${i}`}
                className="border-t align-top"
                style={{ borderColor: colors.border }}
              >
                <td
                  className="p-2"
                  style={{
                    color:
                      f.severity === "error"
                        ? "#f87171"
                        : f.severity === "warn"
                          ? "#fbbf24"
                          : colors.textSecondary,
                  }}
                >
                  {f.severity.toUpperCase()}
                </td>
                <td className="p-2 whitespace-nowrap">{f.code}</td>
                <td className="p-2">{f.account_id ?? "—"}</td>
                <td className="p-2">
                  {f.symbol && f.account_id ? (
                    <button
                      type="button"
                      className="underline"
                      style={{ color: colors.accent }}
                      onClick={() => {
                        if (f.account_id && f.symbol)
                          setCard({ accountId: f.account_id, symbol: f.symbol });
                      }}
                    >
                      {f.symbol}
                    </button>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="p-2">
                  <p>{f.message}</p>
                  {Object.keys(f.evidence).length > 0 && (
                    <details className="mt-1" style={{ color: colors.textSecondary }}>
                      <summary className="cursor-pointer">Evidence</summary>
                      <pre className="whitespace-pre-wrap py-2">
                        {JSON.stringify(f.evidence, null, 2)}
                      </pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card && <StockCardModal {...card} colors={colors} onClose={() => setCard(null)} />}
    </div>
  );
}
