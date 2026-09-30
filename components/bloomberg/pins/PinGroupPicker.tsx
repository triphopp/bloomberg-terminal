"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PinGroup } from "../atoms";
import type { bloombergColors } from "../lib/theme-config";

/**
 * Group popover shared by global search and the stock view.
 *
 * - a check mark sits on the group the symbol is in now;
 * - when the symbol is already pinned, the other groups read "Move to <name>"
 *   (a move, never a copy - see usePinActions);
 * - "+ New group..." opens an inline input: Enter creates the group AND pins /
 *   moves the symbol in one call, Escape cancels.
 */
export function PinGroupPicker({
  groups,
  currentGroupId,
  onPick,
  onCreate,
  onClose,
  colors,
  busy = false,
  className = "absolute right-0 top-full mt-1 z-[200] border min-w-[180px]",
}: {
  groups: PinGroup[];
  /** Group the symbol is pinned in right now; undefined when it is not pinned. */
  currentGroupId?: string;
  onPick: (group: PinGroup) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
  colors: typeof bloombergColors.dark;
  busy?: boolean;
  className?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const isPinned = currentGroupId !== undefined;

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submit = () => {
    const n = name.trim();
    if (!n || busy) return;
    onCreate(n);
  };

  return (
    <div
      className={className}
      style={{ background: colors.surface, borderColor: colors.border }}
      role="presentation"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="px-3 py-1.5 text-xs font-bold border-b"
        style={{ color: colors.accent, borderColor: colors.border }}
      >
        {isPinned ? "MOVE TO GROUP" : "PIN TO GROUP"}
      </div>
      {groups.map((g) => {
        const here = g.id === currentGroupId;
        return (
          <button
            type="button"
            key={g.id}
            disabled={busy}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:opacity-70 transition-opacity disabled:opacity-40"
            style={{ color: colors.text }}
            title={here ? "Already in this group" : undefined}
            onClick={() => onPick(g)}
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />
            <span className="flex-1 text-left truncate">
              {isPinned && !here ? `Move to ${g.name}` : g.name}
            </span>
            {here && <Check className="h-3 w-3 shrink-0" style={{ color: "#4ade80" }} />}
          </button>
        );
      })}
      <div className="border-t" style={{ borderColor: colors.border }}>
        {creating ? (
          <div className="flex items-center gap-1 px-2 py-1.5">
            <input
              ref={inputRef}
              className="flex-1 min-w-0 text-xs px-1.5 py-1 border outline-none font-mono"
              style={{
                background: colors.background,
                color: colors.text,
                borderColor: colors.border,
              }}
              placeholder="Group name, Enter to create"
              value={name}
              maxLength={40}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setCreating(false);
                  setName("");
                }
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            className="w-full text-left px-3 py-2 text-xs font-bold hover:opacity-70 disabled:opacity-40"
            style={{ color: colors.accent }}
            onClick={() => setCreating(true)}
          >
            + New group…
          </button>
        )}
      </div>
      <button
        type="button"
        className="w-full text-left px-3 py-1.5 text-xs border-t"
        style={{ color: colors.textSecondary, borderColor: colors.border }}
        onClick={onClose}
      >
        Cancel
      </button>
    </div>
  );
}
