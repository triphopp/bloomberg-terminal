"use client";

/**
 * PORT → RISK: the journal of risk decisions — why a stop or a rebalance was
 * held, followed or changed, with the numbers of that moment.
 *
 * Rows arrive from three places and are never edited:
 *   TRADE GUARD → HOLD          (stop not followed, with its review date and floor)
 *   REBALANCE → ยังไม่ขาย        (take-profit declined for now, with a review date)
 *   a stop level edited on a lot (PORT → trade edit, with the reason typed there)
 * and anything typed here by hand: followed the plan, changed it, or a note.
 *
 * Backend: GET | POST /api/v2/portfolio/risk/decisions, DELETE …/{id} ends a
 * live REBALANCE hold (backend/risk_journal.py). Saved on this machine only.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Colors } from "../helpers";
import { fmtAmt, fmtPx } from "../helpers";
import { Shell } from "./WhatIfSimPanel";

export type DecisionKind = "STOP" | "REBALANCE" | "BUDGET" | "OTHER";
export type DecisionType = "HOLD" | "FOLLOW" | "CHANGE" | "NOTE";

export interface RiskDecision {
  id: string;
  kind: DecisionKind;
  decision: DecisionType;
  account_id: string | null;
  symbol: string | null;
  yf_symbol: string | null;
  reason: string;
  snapshot: Record<string, unknown>;
  review_on: string | null;
  ref_id: string | null;
  source: string;
  cleared_at: string | null;
  created_at: string;
  active: boolean;
}

interface DecisionsData {
  decisions: RiskDecision[];
  counts: Partial<Record<DecisionKind, number>>;
  active_holds: number;
  error?: string;
}

export const KIND_LABEL: Record<DecisionKind, string> = {
  STOP: "STOP LOSS",
  REBALANCE: "REBALANCE",
  BUDGET: "งบความเสี่ยง",
  OTHER: "อื่นๆ",
};

export const DECISION_LABEL: Record<DecisionType, string> = {
  HOLD: "ไม่ทำตาม · ถือต่อ",
  FOLLOW: "ทำตาม",
  CHANGE: "เปลี่ยนแผน",
  NOTE: "บันทึก",
};

const KINDS: DecisionKind[] = ["STOP", "REBALANCE", "BUDGET", "OTHER"];
/** HOLD is written where the holding is (TRADE GUARD / REBALANCE), not here. */
const MANUAL_TYPES: Exclude<DecisionType, "HOLD">[] = ["FOLLOW", "CHANGE", "NOTE"];

export function useRiskDecisions(accountId: string) {
  return useQuery<DecisionsData>({
    queryKey: ["risk-decisions", accountId],
    queryFn: async () => {
      const qs = accountId !== "all" ? `?account_id=${accountId}` : "";
      const r = await fetch(`/api/v2/portfolio/risk/decisions${qs}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
  });
}

/** POST one decision; throws with the server's reason on a refusal. */
export async function postRiskDecision(body: {
  kind: DecisionKind;
  decision: DecisionType;
  reason: string;
  account_id?: string | null;
  symbol?: string | null;
  yf_symbol?: string | null;
  snapshot?: Record<string, unknown>;
  review_days?: number;
}): Promise<{ id: string; review_on: string | null }> {
  const r = await fetch("/api/v2/portfolio/risk/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.detail ?? d.error ?? `HTTP ${r.status}`);
  return d;
}

export async function endRiskDecision(id: string): Promise<void> {
  const r = await fetch(`/api/v2/portfolio/risk/decisions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.detail ?? d.error ?? `HTTP ${r.status}`);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The numbers that were on screen when the decision was made, in one line. */
function snapshotLine(d: RiskDecision): string {
  const s = d.snapshot ?? {};
  const parts: string[] = [];
  const weight = num(s.weight_pct);
  const target = num(s.target_pct);
  if (weight != null)
    parts.push(
      `น้ำหนัก ${weight.toFixed(1)}%${target != null ? ` → เป้า ${target.toFixed(1)}%` : ""}`
    );
  const gain = num(s.growth_pct);
  if (gain != null) parts.push(`กำไร ${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%`);
  const sell = num(s.sell_value);
  if (sell != null && sell > 0) parts.push(`แผนขาย ฿${fmtAmt(sell)}`);
  const from = num(s.stop_from);
  const to = num(s.stop_to);
  if (from != null || to != null)
    parts.push(`stop ${from != null ? fmtPx(from) : "—"} → ${to != null ? fmtPx(to) : "ยกเลิก"}`);
  if (Array.isArray(s.codes) && s.codes.length)
    parts.push(s.codes.join(" + ").replaceAll("_", " "));
  const floor = num(s.floor_price);
  if (floor != null) parts.push(`floor ${fmtPx(floor)}`);
  const price = num(s.price);
  if (price != null) parts.push(`ราคา ${fmtPx(price)}`);
  return parts.join(" · ");
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function DecisionJournalPanel({
  accountId,
  colors,
}: {
  accountId: string;
  colors: Colors;
}) {
  const qc = useQueryClient();
  const { data, error } = useRiskDecisions(accountId);
  const [filter, setFilter] = useState<DecisionKind | "ALL">("ALL");
  const [showAll, setShowAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<DecisionKind>("STOP");
  const [type, setType] = useState<Exclude<DecisionType, "HOLD">>("FOLLOW");
  const [symbol, setSymbol] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["risk-decisions"] }),
      qc.invalidateQueries({ queryKey: ["rebalance"] }),
    ]);
  };

  const submit = async () => {
    if (!reason.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await postRiskDecision({
        kind,
        decision: type,
        reason: reason.trim(),
        symbol: symbol.trim() || null,
        account_id: accountId !== "all" ? accountId : null,
      });
      setReason("");
      setSymbol("");
      setAdding(false);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const end = async (id: string) => {
    setErr(null);
    try {
      await endRiskDecision(id);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const all = data?.decisions ?? [];
  const rows = filter === "ALL" ? all : all.filter((d) => d.kind === filter);
  const shown = showAll ? rows : rows.slice(0, 8);
  const opt = (on: boolean) => ({
    color: on ? colors.accent : colors.textSecondary,
    textDecoration: on ? "underline" : "none",
  });
  const iStyle = { background: "transparent", color: colors.text, borderColor: colors.border };

  return (
    <Shell
      colors={colors}
      title={`บันทึกการตัดสินใจ · STOP LOSS / REBALANCE${data?.active_holds ? ` · ถือต่ออยู่ ${data.active_holds}` : ""}`}
      right={
        <>
          <button
            aria-pressed={filter === "ALL"}
            type="button"
            onClick={() => setFilter("ALL")}
            style={opt(filter === "ALL")}
          >
            ทั้งหมด {all.length}
          </button>
          {KINDS.filter((k) => data?.counts[k]).map((k) => (
            <button
              aria-pressed={filter === k}
              type="button"
              key={k}
              onClick={() => setFilter(k)}
              style={opt(filter === k)}
            >
              {KIND_LABEL[k]} {data?.counts[k]}
            </button>
          ))}
          <button
            aria-pressed={adding}
            type="button"
            onClick={() => setAdding((v) => !v)}
            style={{ color: colors.accent }}
          >
            {adding ? "▾ เพิ่มบันทึก" : "+ เพิ่มบันทึก"}
          </button>
        </>
      }
    >
      {adding && (
        <div
          className="p-2 flex flex-col gap-1.5"
          style={{ background: colors.surfaceDeep, fontSize: 9.5 }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ color: colors.textSecondary }}>เรื่อง</span>
            {KINDS.map((k) => (
              <button
                aria-pressed={kind === k}
                type="button"
                key={k}
                onClick={() => setKind(k)}
                style={opt(kind === k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
            <span className="ml-2" style={{ color: colors.textSecondary }}>
              ทำอะไร
            </span>
            {MANUAL_TYPES.map((t) => (
              <button
                aria-pressed={type === t}
                type="button"
                key={t}
                onClick={() => setType(t)}
                style={opt(type === t)}
              >
                {DECISION_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              className="w-24 border px-1 outline-none uppercase"
              style={iStyle}
              placeholder="หุ้น (ถ้ามี)"
              aria-label="Symbol (optional)"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            />
            <input
              className="min-w-0 flex-1 border px-1 outline-none"
              style={iStyle}
              placeholder="เหตุผล — ทำไมถึงทำตาม / ไม่ทำตาม / เปลี่ยนแผน"
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />
            <button
              type="button"
              disabled={busy || !reason.trim()}
              onClick={() => void submit()}
              className="px-2 border font-bold"
              style={{
                borderColor: reason.trim() ? colors.accent : colors.border,
                color: reason.trim() ? colors.accent : colors.textSecondary,
              }}
            >
              {busy ? "…" : "บันทึก"}
            </button>
          </div>
          <span style={{ color: colors.textSecondary, opacity: 0.8, fontSize: 8.5 }}>
            "ไม่ทำตาม · ถือต่อ" บันทึกจากที่ตัวหุ้นอยู่: TRADE GUARD → HOLD (stop) หรือ REBALANCE → ยังไม่ขาย —
            เพราะต้องมีวันทบทวน
          </span>
        </div>
      )}
      {err && <span style={{ color: colors.negative }}>{err}</span>}
      {error ? (
        <span style={{ color: colors.negative }}>โหลดบันทึกไม่ได้ — {String(error)}</span>
      ) : !data ? (
        <span style={{ color: colors.textSecondary }}>กำลังโหลดบันทึก…</span>
      ) : rows.length === 0 ? (
        <span style={{ color: colors.textSecondary }}>
          ยังไม่มีบันทึก — เมื่อกด HOLD ใน TRADE GUARD, "ยังไม่ขาย" ใน REBALANCE หรือแก้ stop ของไม้ที่เปิดอยู่
          เหตุผลจะมาอยู่ที่นี่
        </span>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: 9.5 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {["วันที่", "เรื่อง", "หุ้น", "ตัดสินใจ", "เหตุผล", "ตัวเลขตอนนั้น", "ทบทวน", ""].map((h, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed header list
                    key={i}
                    className="text-left font-normal px-1 py-0.5 whitespace-nowrap"
                    style={{ color: colors.textSecondary }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => {
                const ended = d.decision === "HOLD" && !d.active;
                const tone =
                  d.decision === "HOLD"
                    ? d.active
                      ? "#FFB300"
                      : colors.textSecondary
                    : d.decision === "FOLLOW"
                      ? colors.positive
                      : d.decision === "CHANGE"
                        ? colors.accent
                        : colors.textSecondary;
                return (
                  <tr key={d.id} style={{ borderBottom: `1px solid ${colors.border}33` }}>
                    <td
                      className="px-1 py-0.5 whitespace-nowrap tabular-nums"
                      style={{ color: colors.textSecondary }}
                      title={d.created_at}
                    >
                      {day(d.created_at)}
                    </td>
                    <td className="px-1 whitespace-nowrap" style={{ color: colors.textSecondary }}>
                      {KIND_LABEL[d.kind] ?? d.kind}
                    </td>
                    <td className="px-1 whitespace-nowrap font-bold" style={{ color: colors.text }}>
                      {d.symbol ?? "—"}
                    </td>
                    <td className="px-1 whitespace-nowrap font-bold" style={{ color: tone }}>
                      {DECISION_LABEL[d.decision] ?? d.decision}
                    </td>
                    <td className="px-1" style={{ color: colors.text, minWidth: 160 }}>
                      {d.reason}
                    </td>
                    <td className="px-1 tabular-nums" style={{ color: colors.textSecondary }}>
                      {snapshotLine(d) || "—"}
                    </td>
                    <td
                      className="px-1 whitespace-nowrap tabular-nums"
                      style={{ color: d.active ? "#FFB300" : colors.textSecondary }}
                    >
                      {d.decision !== "HOLD"
                        ? "—"
                        : d.active
                          ? `ถึง ${day(d.review_on)}`
                          : d.cleared_at
                            ? `จบ ${day(d.cleared_at)}`
                            : `ครบ ${day(d.review_on)}`}
                    </td>
                    <td className="px-1 whitespace-nowrap text-right">
                      {d.active && d.source !== "guard" && (
                        <button
                          type="button"
                          onClick={() => void end(d.id)}
                          style={{ color: colors.textSecondary }}
                          title="จบการถือต่อเดี๋ยวนี้ — แถวยังอยู่ในบันทึก และ REBALANCE กลับมาเตือน"
                        >
                          จบ HOLD
                        </button>
                      )}
                      {ended && d.source === "guard" && (
                        <span style={{ color: colors.textSecondary, fontSize: 8.5 }}>GUARD</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 8 && (
        <button
          aria-pressed={showAll}
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start"
          style={{ color: colors.accent, fontSize: 9 }}
        >
          {showAll ? "▾ ย่อ" : `▸ ดูทั้งหมด (${rows.length})`}
        </button>
      )}
      <div style={{ color: colors.textSecondary, opacity: 0.75, fontSize: 8.5 }}>
        แถวไม่ถูกแก้หรือลบ — การเปลี่ยนใจคือแถวใหม่ · เก็บในฐานข้อมูลของเครื่องนี้ (ตาราง risk_decisions ยังไม่ sync
        ข้ามเครื่อง)
      </div>
    </Shell>
  );
}
