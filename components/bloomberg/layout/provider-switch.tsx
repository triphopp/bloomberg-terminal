"use client";

import React, { useState } from "react";
import { bloombergColors } from "../lib/theme-config";
import { useProviders } from "../hooks/useProviders";

/**
 * Header chip: shows the active quote provider + a health dot, and opens a
 * popover to switch providers or toggle auto-failover. Self-contained — owns
 * its own data via useProviders().
 */
export function ProviderSwitch({ isDarkMode }: { isDarkMode: boolean }) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;
  const sep = `1px solid ${colors.border}33`;
  const [open, setOpen] = useState(false);
  const { providers, active, setActive, setAutoFailover, switching } = useProviders();

  const activeP = providers.find((p) => p.name === active);
  const dot = (healthy: boolean) => (healthy ? colors.positive : "#FF4444");
  const autoOn = providers[0]?.auto_failover ?? true;

  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 h-full transition-opacity hover:opacity-100"
        style={{ color: colors.textSecondary, fontSize: 9, borderLeft: sep, opacity: 0.85 }}
        title="Quote data provider"
      >
        <span
          className="inline-block rounded-full"
          style={{ width: 6, height: 6, background: dot(activeP?.healthy ?? false) }}
        />
        <span className="font-bold" style={{ color: colors.accent }}>
          {activeP?.name.toUpperCase() ?? "FEED"}
        </span>
        <span style={{ opacity: 0.45, fontSize: 8 }}>▾</span>
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 z-50 mt-px flex flex-col p-1.5 border min-w-[180px]"
            style={{ background: "#0a0a0a", borderColor: colors.border, top: "100%" }}
          >
            <div
              className="text-[8px] font-bold uppercase tracking-widest px-1 pb-1 mb-1"
              style={{ color: colors.textSecondary, borderBottom: sep }}
            >
              Quote Provider
            </div>

            {providers.map((p) => (
              <button
                key={p.name}
                type="button"
                disabled={switching}
                onClick={() => { setActive(p.name); setOpen(false); }}
                className="flex items-center gap-1.5 px-1.5 py-1 text-[9px] hover:opacity-80 text-left"
                style={{
                  color: p.active ? colors.accent : colors.text,
                  background: p.active ? `${colors.accent}18` : "transparent",
                }}
              >
                <span
                  className="inline-block rounded-full shrink-0"
                  style={{ width: 6, height: 6, background: dot(p.healthy) }}
                />
                <span className="font-bold">{p.label}</span>
                {p.last_served && (
                  <span style={{ fontSize: 7, opacity: 0.5, marginLeft: "auto" }}>serving</span>
                )}
                {p.active && !p.last_served && (
                  <span style={{ fontSize: 7, opacity: 0.5, marginLeft: "auto" }}>active</span>
                )}
              </button>
            ))}

            <label
              className="flex items-center gap-1.5 px-1.5 py-1 mt-1 text-[8px] cursor-pointer"
              style={{ color: colors.textSecondary, borderTop: sep }}
            >
              <input
                type="checkbox"
                checked={autoOn}
                onChange={(e) => setAutoFailover(e.target.checked)}
                style={{ accentColor: colors.accent, width: 10, height: 10 }}
              />
              Auto-failover to next healthy
            </label>
          </div>
        </>
      )}
    </div>
  );
}
