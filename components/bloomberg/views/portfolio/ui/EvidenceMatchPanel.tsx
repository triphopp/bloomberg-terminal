"use client";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import type { EvidenceReport, EvidenceRow, EvidenceStatus } from "../accounting-types";
import type { Colors } from "../helpers";

const STATUS_LABEL: Record<EvidenceStatus, string> = {
  MATCHED: "MATCHED",
  CONSOLIDATED: "MERGED",
  NETTED: "NETTED",
  MISSING_IN_DB: "MISSING",
  NO_EVIDENCE: "NO EVIDENCE",
  OUT_OF_COVERAGE: "UNCHECKED",
};

const STATUS_HELP: Record<EvidenceStatus, string> = {
  MATCHED: "One broker fill = one book row",
  CONSOLIDATED: "Several fills merged into one book lot (same quantity, average price)",
  NETTED: "Book kept only the unsold remainder; the sold part and its P&L are missing",
  MISSING_IN_DB: "Broker fill with no book row",
  NO_EVIDENCE: "Book row inside the screenshot period with no broker fill",
  OUT_OF_COVERAGE: "Book row outside the screenshot period — not checked",
};

function num(v: number | null | undefined, digits = 2) {
  if (v == null) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function signed(v: number | null | undefined) {
  if (v == null) return "—";
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v > 0.004 ? `+${s}` : v < -0.004 ? `−${s}` : "0.00";
}

/**
 * Broker screenshots (broker_executions) vs the book reconstructed from legacy
 * trades. Read-only: it reports; corrections are a separate, approved step.
 */
export function EvidenceMatchPanel({ accountId, colors }: { accountId: string; colors: Colors }) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const [showUnchecked, setShowUnchecked] = useState(false);
  const { data, error, isFetching, refetch } = useQuery<EvidenceReport>({
    queryKey: ["portfolio-evidence-match", accountId],
    queryFn: async ({ signal }) => {
      const qs = new URLSearchParams();
      if (accountId !== "all") qs.set("account_id", accountId);
      const r = await fetch(`/api/v2/portfolio/ledger/evidence?${qs}`, { signal });
      const body = await r.json();
      if (!r.ok) throw new Error(body.detail || "Evidence match failed");
      return body;
    },
    staleTime: 30_000,
  });

  const statusColor = (s: EvidenceStatus) =>
    s === "MATCHED" || s === "CONSOLIDATED"
      ? "#4ade80"
      : s === "OUT_OF_COVERAGE"
        ? colors.textSecondary
        : "#fbbf24";

  const rowsFor = (key: string): EvidenceRow[] =>
    (data?.rows ?? []).filter(
      (r) =>
        `${r.account_id}|${r.symbol}` === key && (showUnchecked || r.status !== "OUT_OF_COVERAGE")
    );

  return (
    <div className="h-full flex flex-col overflow-hidden text-[10px]">
      <div
        className="shrink-0 flex flex-wrap items-center gap-3 px-3 py-2 border-b"
        style={{ borderColor: colors.border }}
      >
        <span>{data ? `${data.fills} broker fills` : "—"}</span>
        {data &&
          (Object.keys(STATUS_LABEL) as EvidenceStatus[])
            .filter((s) => data.counts[s])
            .map((s) => (
              <span key={s} title={STATUS_HELP[s]} style={{ color: statusColor(s) }}>
                {STATUS_LABEL[s]} {data.counts[s]}
              </span>
            ))}
        <label className="flex items-center gap-1" style={{ color: colors.textSecondary }}>
          <input
            type="checkbox"
            checked={showUnchecked}
            onChange={(e) => setShowUnchecked(e.target.checked)}
          />
          SHOW UNCHECKED
        </label>
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
          <div className="p-3 space-y-1" style={{ color: colors.textSecondary }}>
            <p>
              PREVIEW · broker screenshots vs the book rebuilt from recorded trades · times read as{" "}
              {data.display_timezone_assumed}, trade date = New York date. Nothing is written.
            </p>
            {Object.entries(data.totals).map(([ccy, t]) => (
              <p key={ccy}>
                {ccy} · cash gap before fees {signed(t.cash_gap_ex_fees)} · commissions not in book{" "}
                {num(t.fee_gap)} · realized P&L missing from book {signed(t.missing_realized)}
              </p>
            ))}
            <p>{data.note}</p>
          </div>
        )}
        {data && data.fills === 0 && (
          <p className="px-3 py-4">
            No broker fills recorded for this account. Import cited screenshots with
            scripts/import_broker_executions.py.
          </p>
        )}
        {data && data.symbols.length > 0 && (
          <table className="w-full">
            <thead className="sticky top-0 bg-[#111]">
              <tr>
                {[
                  "SYMBOL",
                  "ACCOUNT",
                  "SCREENSHOT PERIOD",
                  "FILLS",
                  "NET QTY BROKER / BOOK",
                  "STATUS",
                  "CASH GAP EX FEES",
                  "FEES",
                  "MISSING P&L",
                  "RESULT",
                ].map((h) => (
                  <th key={h} className="text-left p-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.symbols.map((s) => {
                const key = `${s.account_id}|${s.symbol}`;
                const open = symbol === key;
                return (
                  <Fragment key={key}>
                    <tr className="border-t align-top" style={{ borderColor: colors.border }}>
                      <td className="p-2">
                        <button
                          type="button"
                          className="underline"
                          style={{ color: colors.accent }}
                          aria-expanded={open}
                          onClick={() => setSymbol(open ? null : key)}
                        >
                          {open ? "▾" : "▸"} {s.symbol}
                        </button>
                      </td>
                      <td className="p-2">{s.account_id}</td>
                      <td className="p-2 whitespace-nowrap">
                        {s.coverage_from} → {s.coverage_to}
                      </td>
                      <td className="p-2 text-right">{s.fills}</td>
                      <td
                        className="p-2 whitespace-nowrap"
                        style={{ color: s.qty_match ? undefined : "#f87171" }}
                      >
                        {num(s.broker_net_qty, 7)} / {num(s.book_net_qty, 7)}{" "}
                        {s.qty_match ? "✓" : "✗"}
                      </td>
                      <td className="p-2">
                        {(Object.keys(STATUS_LABEL) as EvidenceStatus[])
                          .filter((k) => s.counts[k] && k !== "OUT_OF_COVERAGE")
                          .map((k) => (
                            <span key={k} className="mr-2" style={{ color: statusColor(k) }}>
                              {STATUS_LABEL[k]} {s.counts[k]}
                            </span>
                          ))}
                      </td>
                      <td className="p-2 text-right whitespace-nowrap">
                        {signed(s.cash_gap_ex_fees)} {s.currency}
                      </td>
                      <td className="p-2 text-right">{num(s.fee_gap)}</td>
                      <td className="p-2 text-right">{signed(s.missing_realized)}</td>
                      <td className="p-2" style={{ color: s.verified ? "#4ade80" : "#fbbf24" }}>
                        {s.verified ? "VERIFIED" : "REVIEW"}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={10} className="px-4 pb-3">
                          <EvidenceRows rows={rowsFor(key)} colors={colors} color={statusColor} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function EvidenceRows({
  rows,
  colors,
  color,
}: {
  rows: EvidenceRow[];
  colors: Colors;
  color: (s: EvidenceStatus) => string;
}) {
  if (!rows.length) return <p className="py-2">No rows for this filter.</p>;
  return (
    <table className="w-full" style={{ color: colors.textSecondary }}>
      <thead>
        <tr>
          {[
            "STATUS",
            "SIDE",
            "TRADE DATE (NY)",
            "SCREEN TIME",
            "BROKER QTY @ PRICE",
            "BOOK DATE",
            "BOOK QTY @ PRICE",
            "BROKER CASH",
            "BOOK CASH",
            "FEE",
            "EVIDENCE",
          ].map((h) => (
            <th key={h} className="text-left p-1">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={`${r.status}|${r.fill_ids.join(",")}|${r.event_ids.join(",")}`}
            className="border-t align-top"
            style={{ borderColor: colors.border }}
          >
            <td className="p-1" style={{ color: color(r.status) }} title={STATUS_HELP[r.status]}>
              {STATUS_LABEL[r.status]}
              {r.status === "NETTED" && r.sold_qty != null ? ` · sold ${num(r.sold_qty, 7)}` : ""}
            </td>
            <td className="p-1">{r.side}</td>
            <td className="p-1">{r.us_date ?? "—"}</td>
            <td className="p-1 whitespace-nowrap">{r.local_time?.replace("T", " ") ?? "—"}</td>
            <td className="p-1 whitespace-nowrap">
              {r.fill_qty == null ? "—" : `${num(r.fill_qty, 7)} @ ${num(r.fill_price, 4)}`}
            </td>
            <td className="p-1">{r.book_date ?? "—"}</td>
            <td className="p-1 whitespace-nowrap">
              {r.book_qty == null ? "—" : `${num(r.book_qty, 7)} @ ${num(r.book_price, 4)}`}
            </td>
            <td className="p-1 text-right">{signed(r.broker_cash)}</td>
            <td className="p-1 text-right">{signed(r.book_cash)}</td>
            <td className="p-1 text-right">{r.fee_gap ? num(r.fee_gap) : "—"}</td>
            <td className="p-1">
              {r.fill_ids.length > 0 ? (
                <a
                  href={`/api/v2/portfolio/ledger/evidence/image?fill_id=${encodeURIComponent(r.fill_ids[0])}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                  style={{ color: colors.accent }}
                  title={r.images.join(", ")}
                >
                  IMAGE{r.images.length > 1 ? ` (${r.images.length})` : ""}
                </a>
              ) : (
                "—"
              )}
              {r.status === "NETTED" && r.missing_realized != null && (
                <span className="ml-2">P&L missing {signed(r.missing_realized)}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
