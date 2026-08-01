"use client";

/**
 * AlertBellCell — the second entry point from plan §9.5: discoverability +
 * status in one icon. Dim/hover-only when a symbol has no rules; solid with
 * a count badge the moment it has at least one, since "how many rules are
 * live on this row" has nowhere else to live on screen.
 */

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Bell, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { rulesForSymbol, useAlertRules } from "../hooks/useAlertRules";
import type { bloombergColors } from "../lib/theme-config";
import { AlertPickerDialog } from "./AlertPickerDialog";

const itemClass = "text-[10px] font-mono px-2 py-1 cursor-pointer rounded-none";

export function AlertBellCell({
  symbol,
  colors,
  hoverVisibilityClass = "group-hover/row:opacity-40",
}: {
  symbol: string;
  colors: typeof bloombergColors.dark;
  /** Tailwind group-hover class matching the row's own group name (e.g.
   *  "group/card" rows need "group-hover/card:opacity-40") — Tailwind's JIT
   *  needs the literal string, so this can't be computed from a group name prop. */
  hoverVisibilityClass?: string;
}) {
  const { rules, patchRule, deleteRule } = useAlertRules();
  const symbolRules = rulesForSymbol(rules, symbol);
  const activeCount = symbolRules.filter((r) => r.enabled).length;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={
              activeCount > 0
                ? `${activeCount} alert${activeCount === 1 ? "" : "s"} on ${symbol}`
                : "Set alert"
            }
            onClick={(e) => e.stopPropagation()}
            className={
              activeCount > 0
                ? "flex items-center gap-0.5 opacity-90 hover:opacity-100"
                : `flex items-center gap-0.5 opacity-0 ${hoverVisibilityClass} hover:!opacity-100 transition-opacity`
            }
          >
            <Bell
              className="h-2.5 w-2.5"
              style={{ color: activeCount > 0 ? colors.accent : colors.textSecondary }}
              fill={activeCount > 0 ? colors.accent : "none"}
            />
            {activeCount > 0 && (
              <span className="text-[8px] font-bold" style={{ color: colors.accent }}>
                {activeCount}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 0,
            padding: 2,
            minWidth: 220,
            maxHeight: 320,
            overflowY: "auto",
          }}
          className="rounded-none"
        >
          {symbolRules.length > 0 && (
            <>
              <DropdownMenuLabel
                className="text-[8px] font-mono uppercase tracking-widest px-2 py-1"
                style={{ color: colors.textSecondary }}
              >
                Alerts on {symbol}
              </DropdownMenuLabel>
              {symbolRules.map((rule) => (
                <DropdownMenuCheckboxItem
                  key={rule.id}
                  className={`${itemClass} flex items-center justify-between gap-2 pl-8`}
                  style={{ color: colors.text }}
                  checked={rule.enabled}
                  onCheckedChange={(enabled) =>
                    patchRule.mutate(
                      { id: rule.id, body: { enabled } },
                      {
                        onError: (err) =>
                          toast.error(`Couldn't update rule: ${(err as Error).message}`),
                      }
                    )
                  }
                >
                  <span className="truncate">{rule.name}</span>
                  <button
                    type="button"
                    title="Delete rule"
                    className="shrink-0 opacity-50 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteRule.mutate(rule.id, {
                        onSuccess: () => toast.success(`Deleted "${rule.name}"`),
                        onError: (err) =>
                          toast.error(`Couldn't delete rule: ${(err as Error).message}`),
                      });
                    }}
                  >
                    <Trash2 className="h-2.5 w-2.5" style={{ color: "#f87171" }} />
                  </button>
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator style={{ background: colors.border }} />
            </>
          )}

          <DropdownMenuItem
            className={itemClass}
            style={{ color: colors.accent }}
            onSelect={(e) => {
              e.preventDefault();
              requestAnimationFrame(() => setPickerOpen(true));
            }}
          >
            ⚡ Quick alert…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        symbol={symbol}
        targets={[symbol]}
        colors={colors}
      />
    </>
  );
}
