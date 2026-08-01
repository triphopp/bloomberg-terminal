"use client";

import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { type AlertRule, useAlertRules } from "../hooks/useAlertRules";
import type { bloombergColors } from "../lib/theme-config";
import { menuItemClass } from "./SymbolContextMenu";

interface AlertsOnSymbolSubmenuProps {
  symbol: string;
  colors: typeof bloombergColors.dark;
  rules: AlertRule[];
}

/** Existing rules touching this symbol — toggle or delete without opening the (not-yet-built) full modal. */
export function AlertsOnSymbolSubmenu({ symbol, colors, rules }: AlertsOnSymbolSubmenuProps) {
  const { patchRule, deleteRule } = useAlertRules();

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={menuItemClass} style={{ color: colors.text }}>
        🔔 Alerts on {symbol} ({rules.length})
      </ContextMenuSubTrigger>
      <ContextMenuSubContent
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
        {rules.map((rule) => (
          <ContextMenuCheckboxItem
            key={rule.id}
            className={`${menuItemClass} flex items-center justify-between gap-2 pl-8`}
            style={{ color: colors.text }}
            checked={rule.enabled}
            onCheckedChange={(enabled) =>
              patchRule.mutate(
                { id: rule.id, body: { enabled } },
                {
                  onError: (err) => toast.error(`Couldn't update rule: ${(err as Error).message}`),
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
                  onError: (err) => toast.error(`Couldn't delete rule: ${(err as Error).message}`),
                });
              }}
            >
              <Trash2 className="h-2.5 w-2.5" style={{ color: "#f87171" }} />
            </button>
          </ContextMenuCheckboxItem>
        ))}
        {rules.length === 0 && (
          <ContextMenuItem
            disabled
            className={menuItemClass}
            style={{ color: colors.textSecondary }}
          >
            No rules yet
          </ContextMenuItem>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
