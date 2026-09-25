"use client";
import type { ReactNode } from "react";
import type { Colors } from "../helpers";
import {
  BLANK_FILTER,
  type LedgerFilter,
  type LedgerSort,
  type RangePreset,
  isFiltered,
} from "../ledger-filter";

// One filter strip for the CASH / DIVIDENDS / REINVEST ledgers. Controls are
// text-only (globals.css): a lit chip is coloured, an unlit one is dim.

export interface TypeOption {
  key: string;
  label: string;
  color: string;
}

const RANGES: RangePreset[] = ["ALL", "1M", "3M", "YTD", "1Y"];
const SORTS: { key: LedgerSort; label: string }[] = [
  { key: "date_desc", label: "DATE ↓" },
  { key: "date_asc", label: "DATE ↑" },
  { key: "amt_desc", label: "AMT ↓" },
  { key: "amt_asc", label: "AMT ↑" },
];

export function LedgerFilterBar({
  filter,
  onUpdate,
  typeOptions,
  accounts,
  years,
  placeholder,
  summary,
  colors,
}: {
  filter: LedgerFilter;
  /** Functional, so two clicks inside one render both land (a toggle reads
   *  the CURRENT filter, not the one this render saw). */
  onUpdate: (fn: (f: LedgerFilter) => LedgerFilter) => void;
  typeOptions: TypeOption[];
  /** Offered only when the tab is scoped to ALL accounts; pass [] otherwise. */
  accounts: { id: string; name: string }[];
  years: string[];
  placeholder: string;
  /** e.g. "12 / 59 rows · in ฿2.1M · out ฿320K" */
  summary: ReactNode;
  colors: Colors;
}) {
  const set = (patch: Partial<LedgerFilter>) => onUpdate((f) => ({ ...f, ...patch }));
  const toggleType = (k: string) =>
    onUpdate((f) => ({
      ...f,
      types: f.types.includes(k) ? f.types.filter((t) => t !== k) : [...f.types, k],
    }));
  const input: React.CSSProperties = {
    background: "#111",
    border: `1px solid ${colors.border}`,
    color: colors.text,
    padding: "1px 5px",
    fontSize: "9px",
    fontFamily: "monospace",
  };
  const chip = (on: boolean, color: string) => ({
    color: on ? color : "#555",
    fontWeight: on ? 700 : 400,
  });
  const nextSort = SORTS[(SORTS.findIndex((s) => s.key === filter.sort) + 1) % SORTS.length];

  return (
    <div
      className="flex items-center gap-x-3 gap-y-1 px-3 py-1 border-b flex-wrap text-[9px] font-mono"
      style={{ borderColor: colors.border, background: "#070707" }}
    >
      <input
        aria-label="Search"
        value={filter.q}
        onChange={(e) => set({ q: e.target.value })}
        placeholder={placeholder}
        style={{ ...input, width: 150 }}
      />

      {typeOptions.length > 0 && (
        <span className="flex items-center gap-2">
          {typeOptions.map((t) => (
            <button
              type="button"
              key={t.key}
              onClick={() => toggleType(t.key)}
              style={chip(filter.types.length === 0 || filter.types.includes(t.key), t.color)}
              title={
                filter.types.includes(t.key)
                  ? `Showing ${t.label} — click to remove`
                  : `Show only ${t.label} (add more to combine)`
              }
            >
              {t.label}
            </button>
          ))}
        </span>
      )}

      <span className="flex items-center gap-2" style={{ color: colors.textSecondary }}>
        {RANGES.map((r) => (
          <button
            type="button"
            key={r}
            onClick={() => set({ range: r })}
            style={chip(filter.range === r, colors.accent)}
          >
            {r}
          </button>
        ))}
        {years.length > 0 && (
          <select
            aria-label="Year"
            value={filter.range === "YEAR" ? filter.year : ""}
            onChange={(e) =>
              e.target.value ? set({ range: "YEAR", year: e.target.value }) : set({ range: "ALL" })
            }
            style={{ ...input, color: filter.range === "YEAR" ? colors.accent : "#777" }}
          >
            <option value="">YEAR</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        )}
        <input
          type="date"
          aria-label="From"
          value={filter.range === "CUSTOM" ? filter.from : ""}
          onChange={(e) => set({ range: "CUSTOM", from: e.target.value })}
          style={input}
        />
        –
        <input
          type="date"
          aria-label="To"
          value={filter.range === "CUSTOM" ? filter.to : ""}
          onChange={(e) => set({ range: "CUSTOM", to: e.target.value })}
          style={input}
        />
      </span>

      {accounts.length > 1 && (
        <select
          aria-label="Account"
          value={filter.account}
          onChange={(e) => set({ account: e.target.value })}
          style={{ ...input, color: filter.account === "all" ? "#777" : colors.accent }}
        >
          <option value="all">ALL ACCTS</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}

      <input
        type="number"
        min={0}
        aria-label="Minimum amount"
        placeholder="≥ amount"
        value={filter.minAmount ?? ""}
        onChange={(e) => {
          const v = Number.parseFloat(e.target.value);
          set({ minAmount: Number.isFinite(v) && v > 0 ? v : null });
        }}
        style={{ ...input, width: 80 }}
      />

      <button
        type="button"
        onClick={() => set({ sort: nextSort.key })}
        style={{ color: colors.textSecondary }}
        title={`Sort — click for ${nextSort.label}`}
      >
        {SORTS.find((s) => s.key === filter.sort)?.label}
      </button>

      <span className="ml-auto" style={{ color: colors.textSecondary }}>
        {summary}
      </span>
      {isFiltered(filter) && (
        <button
          type="button"
          onClick={() => onUpdate((f) => ({ ...BLANK_FILTER, sort: f.sort }))}
          style={{ color: "#f87171" }}
        >
          CLEAR
        </button>
      )}
    </div>
  );
}
