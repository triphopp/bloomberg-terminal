"use client";
import { X } from "lucide-react";
import { useState } from "react";
import type { Colors } from "../helpers";

interface Props {
  title: string;
  message: string;
  colors: Colors;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDeleteModal({ title, message, colors, onCancel, onConfirm }: Props) {
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div
        role="presentation"
        className="border p-4 w-[320px]"
        style={{ background: "#0a0a0a", borderColor: colors.border }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold tracking-widest" style={{ color: "#f87171" }}>
            {title}
          </h3>
          <button type="button" onClick={onCancel} className="p-0.5 hover:opacity-70">
            <X className="h-3 w-3" style={{ color: colors.textSecondary }} />
          </button>
        </div>

        <p className="text-[10px] font-mono mb-4" style={{ color: colors.textSecondary }}>
          {message}
        </p>

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{ borderColor: colors.border, color: colors.textSecondary }}
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={deleting}
            className="text-[9px] px-3 py-1.5 border font-bold"
            style={{
              borderColor: "#ef444466",
              color: deleting ? "#555" : "#f87171",
              background: "#ef444410",
              opacity: deleting ? 0.5 : 1,
            }}
          >
            {deleting ? "..." : "DELETE"}
          </button>
        </div>
      </div>
    </div>
  );
}
