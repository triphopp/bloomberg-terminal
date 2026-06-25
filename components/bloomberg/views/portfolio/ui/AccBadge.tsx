"use client";
import { FLAG } from "../helpers";
import type { Account } from "../types";

export function AccBadge({ account, small }: { account: Account; small?: boolean }) {
  const flag = FLAG[account.country] ?? "🌐";
  const sz = small ? "text-[9px]" : "text-[10px]";
  return (
    <span className={`font-bold font-mono ${sz}`}>
      {flag} {account.name.toUpperCase()}
      <span className="ml-1 opacity-50">{account.currency}</span>
    </span>
  );
}

export function WLBadge({ wl }: { wl: string }) {
  const bg = wl === "W" ? "#22c55e22" : wl === "L" ? "#ef444422" : "#f59e0b22";
  const cl = wl === "W" ? "#4ade80" : wl === "L" ? "#f87171" : "#f59e0b";
  return (
    <span
      className="text-[8px] px-1 font-bold"
      style={{ background: bg, color: cl, border: `1px solid ${cl}44` }}
    >
      {wl}
    </span>
  );
}
