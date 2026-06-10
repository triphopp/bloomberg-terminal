"use client";

import React from "react";
import type { ThemeColors } from "../lib/theme-config";

// ── PanelHeader — ส่วนหัวของทุก panel ─────────────────────────────────────────

export function PanelHeader({
  icon,
  label,
  count,
  children,
  colors,
}: {
  icon?: React.ReactNode;
  label: string;
  count?: number;
  children?: React.ReactNode;
  colors: ThemeColors;
}) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-1 shrink-0"
      style={{ background: colors.surface, borderBottom: `1px solid ${colors.border}` }}
    >
      {icon}
      <span
        className="text-[9px] font-bold font-mono tracking-widest"
        style={{ color: colors.accent }}
      >
        {label}
      </span>
      {count !== undefined && (
        <span className="text-[9px] font-mono" style={{ color: colors.textSecondary }}>
          ({count})
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  );
}

// ── TableHeaderRow — header row ของทุก table ──────────────────────────────────

export function TableHeaderRow({
  columns,
  colors,
}: {
  columns: { label: string; width?: string; align?: "left" | "right" }[];
  colors: ThemeColors;
}) {
  return (
    <div
      className="flex items-center px-1 py-0.5 shrink-0 text-[8px] font-bold font-mono tracking-wider"
      style={{ background: colors.surfaceDeep, borderBottom: `1px solid ${colors.border}`, color: colors.textDimmed }}
    >
      {columns.map((col, i) => (
        <span
          key={i}
          className={`${col.width ?? "flex-1"} ${col.align === "right" ? "text-right" : ""}`}
        >
          {col.label}
        </span>
      ))}
    </div>
  );
}

// ── SectionLabel — section divider ใน list ────────────────────────────────────

export function SectionLabel({
  label,
  colors,
}: {
  label: string;
  colors: ThemeColors;
}) {
  return (
    <div
      className="px-2 py-0.5 text-[8px] font-bold font-mono tracking-widest"
      style={{
        background: "#0d0d0d",
        color: "#444",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      {label}
    </div>
  );
}

// ── DataRow — generic row ใน table ────────────────────────────────────────────

export function DataRow({
  isSelected,
  onClick,
  children,
  colors,
}: {
  isSelected?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  colors: ThemeColors;
}) {
  return (
    <div
      className="flex items-center px-1 py-[3px] border-b cursor-pointer transition-colors"
      style={{
        borderColor: colors.border,
        background: isSelected ? colors.bgSelected : undefined,
        borderLeft: isSelected ? `2px solid ${colors.accentSelected}` : "2px solid transparent",
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = colors.bgHover;
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = "";
      }}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

// ── CompactTabBtn — tab button สำหรับ tab bar ─────────────────────────────────

export function CompactTabBtn({
  active,
  onClick,
  label,
  colors,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  colors: ThemeColors;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 text-xs font-mono font-bold border tracking-wider transition-colors"
      style={{
        borderColor: active ? colors.accent : colors.border,
        backgroundColor: active ? colors.accent : "transparent",
        color: active ? "#000" : colors.text,
      }}
    >
      {label}
    </button>
  );
}
