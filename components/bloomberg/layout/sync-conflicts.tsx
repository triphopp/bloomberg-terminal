"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HEARTBEAT_KEY } from "../hooks/useHeartbeat";
import type { SyncConflict } from "../hooks/useSync";
import { bloombergColors } from "../lib/theme-config";

const SKIP = new Set(["updated_at"]);

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** What a person recognises the row by — symbol/account/date — else its key. */
function label(c: SyncConflict): string {
  const r = c.kept_row ?? c.other_row ?? {};
  const parts = ["symbol", "account_id", "date_entry", "date", "name", "title"]
    .map((k) => r[k])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(String);
  return parts.length ? parts.join(" · ") : c.row_key.replaceAll("\u001f", " / ");
}

/** Fields whose values differ between the kept row and the other side. */
function diffFields(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null
): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => !SKIP.has(k) && cell(a?.[k]) !== cell(b?.[k])).sort();
}

/**
 * Op-log conflict review: the same row was edited on two devices before
 * either saw the other. Both devices already show the kept version (the later
 * edit); the other side's version is preserved here. KEEP leaves it; USE OTHER
 * writes the other version back. Either choice travels to every device.
 */
export function SyncConflicts({
  isDarkMode,
  onClose,
}: { isDarkMode: boolean; onClose: () => void }) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["sync-conflicts"],
    queryFn: async (): Promise<SyncConflict[]> => {
      const r = await fetch("/api/sync/conflicts");
      if (!r.ok) throw new Error("conflicts fetch failed");
      return (await r.json()).conflicts ?? [];
    },
    refetchInterval: 15_000,
  });
  const resolve = useMutation({
    mutationFn: async ({ id, choice }: { id: string; choice: "kept" | "other" }) => {
      const r = await fetch(`/api/sync/conflicts/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice }),
      });
      if (!r.ok) throw new Error("resolve failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sync-conflicts"] });
      // useSync refreshes portfolio data when the next sync round lands
      qc.invalidateQueries({ queryKey: HEARTBEAT_KEY });
    },
  });

  const list = q.data ?? [];
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ background: "#000a" }}
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        className="relative flex flex-col w-[min(760px,94vw)] max-h-[80vh] border"
        style={{ background: "#0a0a0a", borderColor: colors.border, color: colors.text }}
      >
        <div
          className="shrink-0 flex justify-between items-center px-3 py-2 text-[10px] font-bold uppercase tracking-widest"
          style={{ borderBottom: `1px solid ${colors.border}` }}
        >
          <span>Sync conflicts · {list.length}</span>
          <button
            type="button"
            onClick={onClose}
            className="hover:opacity-80"
            style={{ color: colors.textSecondary }}
          >
            CLOSE
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
          {q.isLoading && <div className="text-[10px] opacity-60">Loading…</div>}
          {!q.isLoading && list.length === 0 && (
            <div className="text-[10px] opacity-60">No open conflicts — every device agrees.</div>
          )}
          {list.map((c) => {
            const fields = diffFields(c.kept_row, c.other_row);
            const busy = resolve.isPending && resolve.variables?.id === c.id;
            return (
              <div
                key={c.id}
                className="text-[10px]"
                style={{ borderBottom: `1px solid ${colors.border}33` }}
              >
                <div className="flex justify-between mb-1">
                  <span className="font-bold">
                    {c.table_name} · {label(c)}
                  </span>
                  <span style={{ color: colors.textSecondary }}>{c.reason}</span>
                </div>
                <table className="w-full mb-1.5">
                  <thead>
                    <tr style={{ color: colors.textSecondary }}>
                      <th className="text-left font-normal w-1/4">field</th>
                      <th className="text-left font-normal">kept · {c.kept_device}</th>
                      <th className="text-left font-normal">other · {c.other_device}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {c.kept_row === null && (
                      <tr>
                        <td colSpan={3}>kept side deleted this row</td>
                      </tr>
                    )}
                    {c.other_row === null && (
                      <tr>
                        <td colSpan={3}>other side deleted this row</td>
                      </tr>
                    )}
                    {fields.map((f) => (
                      <tr key={f}>
                        <td style={{ color: colors.textSecondary }}>{f}</td>
                        <td className="break-all">{cell(c.kept_row?.[f])}</td>
                        <td className="break-all" style={{ color: "#F5A623" }}>
                          {cell(c.other_row?.[f])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-3 pb-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => resolve.mutate({ id: c.id, choice: "kept" })}
                    className="font-bold hover:opacity-80"
                    style={{ color: colors.accent }}
                  >
                    KEEP CURRENT
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => resolve.mutate({ id: c.id, choice: "other" })}
                    className="font-bold hover:opacity-80"
                    style={{ color: "#F5A623" }}
                  >
                    USE OTHER
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
