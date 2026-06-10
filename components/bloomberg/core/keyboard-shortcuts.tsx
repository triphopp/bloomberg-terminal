"use client";

import { X } from "lucide-react";
import { useCallback, useEffect } from "react";
import { bloombergColors } from "../lib/theme-config";

interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  action: () => void;
  description: string;
}

interface KeyboardShortcutsProps {
  shortcuts: KeyboardShortcut[];
  isEnabled?: boolean;
}

export function KeyboardShortcuts({ shortcuts, isEnabled = true }: KeyboardShortcutsProps) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isEnabled) return;

      // Block plain-key shortcuts while typing, but always allow:
      // - Modifier shortcuts (Ctrl / Alt / Meta) — mirrors native-app behaviour.
      // - Escape — always acts as back/cancel regardless of focus context.
      const target = event.target as HTMLElement;
      const isTyping =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable;
      const isModified = event.ctrlKey || event.altKey || event.metaKey;
      const isEscape = event.key === "Escape";
      if (isTyping && !isModified && !isEscape) return;

      // Smart Escape: first press blurs the focused input,
      // second press (when nothing is focused) triggers the Esc action (back).
      if (isEscape && isTyping) {
        (target as HTMLElement).blur();
        event.preventDefault();
        return; // Don't fire the Esc shortcut action yet — just blur
      }

      for (const shortcut of shortcuts) {
        const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = !!shortcut.ctrlKey === event.ctrlKey;
        const altMatch = !!shortcut.altKey === event.altKey;
        const shiftMatch = !!shortcut.shiftKey === event.shiftKey;

        if (keyMatch && ctrlMatch && altMatch && shiftMatch) {
          event.preventDefault();
          shortcut.action();
          return;
        }
      }
    },
    [shortcuts, isEnabled]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  return null;
}

interface Shortcut {
  key: string;
  description: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

interface ShortcutsHelpProps {
  shortcuts: Shortcut[];
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
}

export function ShortcutsHelp({ shortcuts, isOpen, onClose, isDarkMode }: ShortcutsHelpProps) {
  const colors = isDarkMode ? bloombergColors.dark : bloombergColors.light;

  if (!isOpen) return null;

  return (
    <dialog
      open={true}
      className="fixed inset-0 z-50 w-full h-full p-0 m-0 max-w-none max-h-none border-none bg-transparent overflow-hidden"
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      aria-labelledby="shortcuts-title"
    >
      {/* Semi-transparent backdrop */}
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />

      {/* Modal container - for centering */}
      <div className="relative w-full h-full flex items-center justify-center">
        <div
          className="w-96 max-h-[80vh] overflow-y-auto border-2 p-4"
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            color: colors.text,
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          tabIndex={-1}
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold">Keyboard Shortcuts</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[${colors.border}]">
                <th className="text-left py-1">Shortcut</th>
                <th className="text-left py-1">Description</th>
              </tr>
            </thead>
            <tbody>
              {shortcuts.map((shortcut) => (
                <tr
                  key={`${shortcut.key}-${shortcut.ctrlKey ? "ctrl" : ""}-${shortcut.altKey ? "alt" : ""}-${shortcut.shiftKey ? "shift" : ""}`}
                  className="border-b border-[${colors.border}]"
                >
                  <td className="py-1">
                    {shortcut.ctrlKey && <span>Ctrl + </span>}
                    {shortcut.altKey && <span>Alt + </span>}
                    {shortcut.shiftKey && <span>Shift + </span>}
                    <span className="font-bold">{shortcut.key.toUpperCase()}</span>
                  </td>
                  <td className="py-1">{shortcut.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </dialog>
  );
}
