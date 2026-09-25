"use client";

import type { ReactNode } from "react";

/** BOND palette. A rising yield or spread is a tightening, so "up" reads red. */
export const C = {
  border: "#1e1e1e",
  label: "#7a7a7a",
  dim: "#5a5a5a",
  amber: "#FFB000",
  up: "#FF6B6B",
  down: "#4ADE80",
} as const;

/** Axis tick: "2026-09-23" → "09/26" (month/year) — the charts span months to years. */
export function fmtDate(d: string): string {
  if (!d || d.length < 10) return d;
  return `${d.slice(5, 7)}/${d.slice(2, 4)}`;
}

export function bpColor(v: number | null | undefined): string {
  if (v == null || v === 0) return "#777";
  return v > 0 ? C.up : C.down;
}

export function fmtBp(v: number | null | undefined, digits = 0): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function Panel({
  title,
  note,
  right,
  children,
  className = "",
}: {
  title: string;
  note?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-1 p-2 min-w-0 ${className}`}
      style={{ border: `1px solid ${C.border}` }}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span style={{ color: C.label, fontSize: 10, letterSpacing: "0.14em" }}>{title}</span>
        {note && <span style={{ color: C.dim, fontSize: 9 }}>{note}</span>}
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </div>
  );
}
