"use client";

// Shared sub-component used across macro tabs.

export function SectionHeader({ title, sub, colors }: { title: string; sub?: string; colors: any }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <span className="text-[10px] font-bold tracking-widest" style={{ color: colors.accent }}>{title}</span>
      {sub && <span className="text-[10px]" style={{ color: colors.textSecondary }}>{sub}</span>}
    </div>
  );
}
