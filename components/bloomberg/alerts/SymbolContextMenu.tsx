"use client";

/**
 * SymbolContextMenu — right-click menu for a WATCHLIST row (plan §9.5).
 *
 * Deliberately a full symbol-action menu, not an alerts-only menu — a menu
 * with one purpose is a menu nobody discovers. Alert creation rides along
 * with actions the user already has a reason to right-click for.
 *
 * Scope note: pin-group / tag-picker actions already have dedicated UI in
 * pinned-assets.tsx (the edit pencil + TagManagerPanel), so this menu covers
 * open/copy/remove + alerts rather than re-implementing those here too.
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { MAX_CHART_WINDOWS, chartWindowsAtom, openChartWindowAtom } from "../atoms/chart-windows";
import { rulesForSymbol, useAlertRules } from "../hooks/useAlertRules";
import type { bloombergColors } from "../lib/theme-config";
import { AlertPickerDialog } from "./AlertPickerDialog";
import { AlertsOnSymbolSubmenu } from "./AlertsOnSymbolSubmenu";

const menuContentStyle = (colors: typeof bloombergColors.dark): React.CSSProperties => ({
  background: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: 0,
  padding: 2,
  minWidth: 200,
  boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
});

export const menuItemClass =
  "text-[10px] font-mono px-2 py-1 cursor-pointer rounded-none focus:bg-white/10 data-[disabled]:opacity-40";

interface SymbolContextMenuProps {
  symbol: string;
  /** When multiple rows are selected, quick alert / new rule apply to all of them. */
  selectedSymbols?: string[];
  colors: typeof bloombergColors.dark;
  onOpen: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  children: React.ReactNode;
}

export function SymbolContextMenu({
  symbol,
  selectedSymbols,
  colors,
  onOpen,
  onRemove,
  children,
}: SymbolContextMenuProps) {
  const targets = selectedSymbols && selectedSymbols.length > 1 ? selectedSymbols : [symbol];
  const { rules } = useAlertRules();
  const symbolRules = rulesForSymbol(rules, symbol);
  const [pickerOpen, setPickerOpen] = useState(false);
  const openChartWindow = useSetAtom(openChartWindowAtom);
  const chartWindows = useAtomValue(chartWindowsAtom);
  // Re-opening a symbol that already has a window just focuses it, so the cap
  // only blocks genuinely new windows.
  const popBlocked =
    chartWindows.length >= MAX_CHART_WINDOWS && !chartWindows.some((w) => w.symbol === symbol);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent style={menuContentStyle(colors)} className="rounded-none">
          <ContextMenuItem
            className={menuItemClass}
            style={{ color: colors.text }}
            onSelect={() => onOpen(symbol)}
          >
            Open in STOCK VIEW
            <ContextMenuShortcut className="text-[9px]">↵</ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuItem
            className={menuItemClass}
            style={{ color: colors.text }}
            disabled={popBlocked}
            onSelect={() => openChartWindow({ symbol })}
          >
            ⧉ Pop out chart
            <ContextMenuShortcut className="text-[9px]">
              {popBlocked ? `max ${MAX_CHART_WINDOWS}` : "float"}
            </ContextMenuShortcut>
          </ContextMenuItem>

          <ContextMenuSeparator style={{ background: colors.border }} />

          <ContextMenuItem
            className={menuItemClass}
            style={{ color: colors.text }}
            onSelect={(e) => {
              e.preventDefault(); // let the menu finish closing before the dialog opens
              requestAnimationFrame(() => setPickerOpen(true));
            }}
          >
            ⚡ Quick alert{targets.length > 1 ? ` (${targets.length} symbols)` : ""}
          </ContextMenuItem>

          {symbolRules.length > 0 && (
            <AlertsOnSymbolSubmenu symbol={symbol} colors={colors} rules={symbolRules} />
          )}

          <ContextMenuSeparator style={{ background: colors.border }} />

          <ContextMenuItem
            className={menuItemClass}
            style={{ color: colors.text }}
            onSelect={() => navigator.clipboard.writeText(symbol)}
          >
            Copy symbol
            <ContextMenuShortcut className="text-[9px]">⌘C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            className={menuItemClass}
            style={{ color: "#f87171" }}
            onSelect={() => onRemove(symbol)}
          >
            Remove from watchlist
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        symbol={symbol}
        targets={targets}
        colors={colors}
      />
    </>
  );
}
