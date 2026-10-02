"use client";
import { useCallback, useEffect, useState } from "react";

/** Fields the ENTRY form hides until asked for.
 *
 * A trade needs an account, a symbol, a date, a price, a volume and a strategy.
 * Stop loss, target, entry trigger and the rest are things you sometimes record
 * and usually do not, and rendering all of them at once pushes the six that
 * matter off the top of the form.
 */
export const EXTRA_FIELDS = [
  { id: "sector", label: "SECTOR", hint: "auto-filled from the symbol" },
  { id: "stop_loss", label: "STOP LOSS", hint: "" },
  { id: "target", label: "TARGET", hint: "" },
  { id: "entry_trigger", label: "ENTRY TRIGGER", hint: "" },
  { id: "vat", label: "FEES", hint: "commission + VAT; blank = broker estimate" },
  { id: "sub_port", label: "SUB-PORT", hint: "" },
  { id: "note", label: "NOTE", hint: "" },
] as const;

export type ExtraField = (typeof EXTRA_FIELDS)[number]["id"];
export type ExtraState = Record<ExtraField, boolean>;

const STORAGE_KEY = "bloomberg_entry_extra_fields";
const NONE: ExtraState = {
  sector: false,
  stop_loss: false,
  target: false,
  entry_trigger: false,
  vat: false,
  sub_port: false,
  note: false,
};

export function useEntryExtras() {
  const [extras, setExtras] = useState<ExtraState>(() => {
    if (typeof window === "undefined") return NONE;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return { ...NONE, ...(JSON.parse(saved) as Partial<ExtraState>) };
    } catch {
      /* ignore */
    }
    return NONE;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(extras));
    } catch {
      /* ignore */
    }
  }, [extras]);

  const toggleExtra = useCallback((id: ExtraField) => {
    setExtras((e) => ({ ...e, [id]: !e[id] }));
  }, []);

  /** Reveal a field the form itself needs — the sector picker when the symbol
   *  could not be classified. Never hides one the user opened. */
  const showExtra = useCallback((id: ExtraField) => {
    setExtras((e) => (e[id] ? e : { ...e, [id]: true }));
  }, []);

  return { extras, toggleExtra, showExtra };
}
