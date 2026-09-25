"use client";

import type {
  RegressionChannelOptions,
  StoredRegressionChannel,
} from "./indicators/regression-channel";

interface RegressionControlsProps {
  channels: StoredRegressionChannel[];
  activeId: string | null;
  armed: boolean;
  pending: boolean;
  options: RegressionChannelOptions;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onModeChange: (mode: "stddev" | "quantile") => void;
  border: string;
  muted: string;
}

export function RegressionControls({
  channels,
  activeId,
  armed,
  pending,
  options,
  onToggle,
  onSelect,
  onRemove,
  onModeChange,
  border,
  muted,
}: RegressionControlsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[8px]">
      <button
        type="button"
        className="shrink-0 border px-1 py-0 font-bold"
        style={{ borderColor: armed ? "#ffc107" : border, color: armed ? "#ffc107" : muted }}
        title={
          armed
            ? "Click two bars to add a channel; click again to cancel"
            : "Add another regression channel"
        }
        onClick={onToggle}
      >
        {armed ? (pending ? "REG 2/2" : "REG 1/2") : "REG +"}
      </button>
      {channels.map((channel, index) => (
        <div key={channel.id} className="flex shrink-0 items-center">
          <button
            type="button"
            className="border px-1 py-0 font-bold"
            style={{
              borderColor: channel.color,
              color: channel.color,
              background: activeId === channel.id ? `${channel.color}22` : "transparent",
            }}
            title={`REG ${index + 1}: ${String(channel.fromTime)} → ${String(channel.toTime)} — select settings`}
            aria-label={`Select regression channel ${index + 1}`}
            onClick={() => onSelect(channel.id)}
          >
            R{index + 1}
          </button>
          <button
            type="button"
            className="border border-l-0 px-0.5 py-0"
            style={{ borderColor: channel.color, color: channel.color }}
            title={`Remove regression channel ${index + 1}`}
            aria-label={`Remove regression channel ${index + 1}`}
            onClick={() => onRemove(channel.id)}
          >
            ×
          </button>
        </div>
      ))}
      {channels.length > 0 && (
        <button
          type="button"
          className="shrink-0 border px-1 py-0 font-bold"
          style={{ borderColor: border, color: muted }}
          title="Change rail mode for the selected regression channel"
          onClick={() => onModeChange(options.mode === "stddev" ? "quantile" : "stddev")}
        >
          {options.mode === "stddev" ? `${options.stdDevMult}σ` : `q${options.tauPct}`}
        </button>
      )}
    </div>
  );
}
