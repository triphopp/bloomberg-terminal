"use client";
import { useAtom } from "jotai";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { ACCOUNT_NAMES, subPortsAtom } from "../constants";
import type { Colors } from "../helpers";

// Dropdown of known sub-ports for a given account, persisted in localStorage.
// "+ Add new sub-port…" lets the user register a brand-new account number
// on the spot — no code edit needed, and it works for any account, not just
// Finansia (Dime, InnovestX, or any future account get the same feature).
export function SubPortSelect({
  accountId,
  value,
  onChange,
  colors,
  inputStyle,
}: {
  accountId: string;
  value: string;
  onChange: (v: string) => void;
  colors: Colors;
  inputStyle: CSSProperties;
}) {
  const [allSubs, setAllSubs] = useAtom(subPortsAtom);
  const [adding, setAdding] = useState(false);
  const [newPort, setNewPort] = useState("");
  const newPortRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) newPortRef.current?.focus();
  }, [adding]);

  const accName = ACCOUNT_NAMES[accountId] ?? accountId;
  const subs = allSubs[accountId] ?? [];

  const addPort = () => {
    const num = newPort.trim();
    if (!num) return;
    const label = `${accName} (${num})`;
    const existing = allSubs[accountId] ?? [];
    if (!existing.includes(label)) {
      setAllSubs({ ...allSubs, [accountId]: [...existing, label] });
    }
    onChange(label);
    setNewPort("");
    setAdding(false);
  };

  if (adding) {
    return (
      <div className="flex gap-1">
        <input
          ref={newPortRef}
          className="flex-1"
          style={inputStyle}
          placeholder="เลขบัญชี e.g. 0153717"
          value={newPort}
          onChange={(e) => setNewPort(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addPort();
            if (e.key === "Escape") setAdding(false);
          }}
        />
        <button
          type="button"
          onClick={addPort}
          className="text-[9px] px-1.5 font-bold"
          style={{ color: colors.accent }}
        >
          ✓
        </button>
        <button
          type="button"
          onClick={() => setAdding(false)}
          className="text-[9px] px-1.5"
          style={{ color: colors.textSecondary }}
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <select
      style={inputStyle}
      value={value}
      onChange={(e) => {
        if (e.target.value === "__add__") setAdding(true);
        else onChange(e.target.value);
      }}
    >
      <option value="">— none —</option>
      {subs.map((s) => (
        <option key={s} value={s}>
          {s.replace(`${accName} (`, "").replace(")", "")}
        </option>
      ))}
      <option value="__add__">+ Add new sub-port…</option>
    </select>
  );
}
