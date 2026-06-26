"use client";

import React, { useState } from "react";
import { useSync } from "../hooks/useSync";
import { bloombergColors } from "../lib/theme-config";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Header chip: cloud-sync state (PC↔Mac via Google Drive). Dot colors:
 *   grey  = disabled,  red = configured but drive offline,
 *   amber = conflicts preserved,  green = synced.
 * Popover shows device, last pull/push, drive path + manual PULL/PUSH.
 */
export function SyncStatus({ isDarkMode }: { isDarkMode: boolean }) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  const sep = `1px solid ${colors.border}33`;
  const [open, setOpen] = useState(false);
  const { status, pull, push, pulling, pushing } = useSync();

  if (!status?.enabled) return null; // hide chip entirely when sync is off

  const conflict = (status.last_conflicts ?? 0) > 0;
  const dot = !status.reachable ? "#FF4444" : conflict ? "#F5A623" : colors.positive;
  const label = !status.reachable ? "OFFLINE" : conflict ? "CONFLICT" : "SYNCED";

  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 h-full transition-opacity hover:opacity-100"
        style={{ color: colors.textSecondary, fontSize: 9, borderLeft: sep, opacity: 0.85 }}
        title="Portfolio cloud sync"
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 6, height: 6, background: dot }}
        />
        <span className="font-bold" style={{ color: colors.accent }}>
          SYNC
        </span>
        <span style={{ opacity: 0.45, fontSize: 8 }}>▾</span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close cloud sync menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            className="absolute right-0 z-50 mt-px flex flex-col p-1.5 border min-w-[220px]"
            style={{ background: "#0a0a0a", borderColor: colors.border, top: "100%" }}
          >
            <div
              className="text-[8px] font-bold uppercase tracking-widest px-1 pb-1 mb-1 flex justify-between"
              style={{ color: colors.textSecondary, borderBottom: sep }}
            >
              <span>Cloud Sync</span>
              <span style={{ color: dot }}>{label}</span>
            </div>

            <div
              className="px-1 py-0.5 text-[9px] flex justify-between"
              style={{ color: colors.text }}
            >
              <span style={{ opacity: 0.6 }}>Device</span>
              <span className="font-bold">{status.device}</span>
            </div>
            <div
              className="px-1 py-0.5 text-[9px] flex justify-between"
              style={{ color: colors.text }}
            >
              <span style={{ opacity: 0.6 }}>Last pull</span>
              <span>{ago(status.last_pull)} ago</span>
            </div>
            <div
              className="px-1 py-0.5 text-[9px] flex justify-between"
              style={{ color: colors.text }}
            >
              <span style={{ opacity: 0.6 }}>Last push</span>
              <span>{ago(status.last_push)} ago</span>
            </div>
            {conflict && (
              <div className="px-1 py-0.5 text-[8px]" style={{ color: "#F5A623" }}>
                {status.last_conflicts} conflict row(s) preserved in conflicts/
              </div>
            )}
            {status.sync_dir && (
              <div
                className="px-1 py-0.5 text-[7px] break-all"
                style={{ color: colors.textSecondary, opacity: 0.5 }}
              >
                {status.sync_dir}
              </div>
            )}

            <div className="flex gap-1 mt-1 pt-1" style={{ borderTop: sep }}>
              <button
                type="button"
                disabled={pulling}
                onClick={() => pull()}
                className="flex-1 px-1.5 py-1 text-[9px] font-bold hover:opacity-80"
                style={{ color: colors.accent, background: `${colors.accent}18` }}
              >
                {pulling ? "PULLING…" : "PULL NOW"}
              </button>
              <button
                type="button"
                disabled={pushing}
                onClick={() => push()}
                className="flex-1 px-1.5 py-1 text-[9px] font-bold hover:opacity-80"
                style={{ color: colors.accent, background: `${colors.accent}18` }}
              >
                {pushing ? "PUSHING…" : "PUSH NOW"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
