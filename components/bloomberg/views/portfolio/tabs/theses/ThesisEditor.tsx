"use client";
import { useState } from "react";
import type { Colors } from "../../helpers";
import { renderMarkdown } from "./markdown";
import { CATEGORIES, HORIZONS, STATUSES, STRATEGIES, type Thesis } from "./types";

export interface ThesisDraft {
  symbol: string;
  title: string;
  category: string;
  sub_portfolio: string;
  strategy: string;
  status: string;
  conviction: string;
  time_horizon: string;
  target_price: string;
  stop_price: string;
  body: string;
  note: string;
}

export const emptyDraft = (symbol = ""): ThesisDraft => ({
  symbol,
  title: "",
  category: "",
  sub_portfolio: "",
  strategy: "",
  status: "draft",
  conviction: "",
  time_horizon: "",
  target_price: "",
  stop_price: "",
  body: "## Claim\n\n\n## Why now\n\n\n## What would kill it\n\n",
  note: "",
});

export const draftFrom = (t: Thesis): ThesisDraft => ({
  symbol: t.symbol,
  title: t.title ?? "",
  category: t.category ?? "",
  sub_portfolio: t.sub_portfolio ?? "",
  strategy: t.strategy ?? "",
  status: t.status,
  conviction: t.conviction == null ? "" : String(t.conviction),
  time_horizon: t.time_horizon ?? "",
  target_price: t.target_price == null ? "" : String(t.target_price),
  stop_price: t.stop_price == null ? "" : String(t.stop_price),
  body: t.body ?? "",
  note: "",
});

export function ThesisEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  saving,
  isNew,
  colors,
}: {
  draft: ThesisDraft;
  setDraft: (d: ThesisDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew: boolean;
  colors: Colors;
}) {
  const [preview, setPreview] = useState(false);
  const set = (k: keyof ThesisDraft) => (v: string) => setDraft({ ...draft, [k]: v });

  // The control is passed in as a node, so the label/input association has to be
  // explicit via id — a nested-but-opaque child is not something a linter (or a
  // screen reader walking the accessibility tree) can resolve on its own.
  const fieldId = (k: keyof ThesisDraft) => `thesis-${k}`;

  const field = (id: string, label: string, node: React.ReactNode) => (
    <div className="flex flex-col gap-0.5">
      <label
        htmlFor={id}
        className="text-[7px] tracking-widest"
        style={{ color: colors.textSecondary }}
      >
        {label}
      </label>
      {node}
    </div>
  );

  const inputStyle = {
    borderColor: colors.border,
    color: colors.text,
    background: "#0a0a0a",
  };

  const text = (k: keyof ThesisDraft, placeholder = "") => (
    <input
      id={fieldId(k)}
      value={draft[k]}
      onChange={(e) => set(k)(e.target.value)}
      placeholder={placeholder}
      className="border px-1 py-0.5 text-[9px] font-mono outline-none"
      style={inputStyle}
    />
  );

  const select = (k: keyof ThesisDraft, options: string[], allowBlank = true) => (
    <select
      id={fieldId(k)}
      value={draft[k]}
      onChange={(e) => set(k)(e.target.value)}
      className="border px-1 py-0.5 text-[9px] font-mono outline-none"
      style={inputStyle}
    >
      {allowBlank && <option value="">—</option>}
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="grid gap-2 mb-2" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        {field(fieldId("symbol"), "SYMBOL", text("symbol", "PLTR"))}
        {field(fieldId("status"), "STATUS", select("status", STATUSES, false))}
        {field(fieldId("category"), "CATEGORY", select("category", CATEGORIES))}
        {field(fieldId("sub_portfolio"), "SUB-PORTFOLIO", text("sub_portfolio", "0153717"))}
        {field(fieldId("title"), "TITLE", text("title", "one-line claim"))}
        {field(fieldId("strategy"), "STRATEGY", select("strategy", STRATEGIES))}
        {field(fieldId("time_horizon"), "HORIZON", select("time_horizon", HORIZONS))}
        {field(fieldId("conviction"), "CONVICTION 1-5", text("conviction", "4"))}
        {field(fieldId("target_price"), "TARGET", text("target_price"))}
        {field(fieldId("stop_price"), "STOP", text("stop_price"))}
        {field(fieldId("note"), "CHANGE NOTE", text("note", "why this edit"))}
      </div>

      <div className="flex items-center justify-between mb-1">
        <label
          htmlFor="thesis-body"
          className="text-[7px] tracking-widest"
          style={{ color: colors.textSecondary }}
        >
          BODY (markdown)
        </label>
        <button
          type="button"
          onClick={() => setPreview((p) => !p)}
          className="text-[7px] px-1.5 py-0.5 border font-bold"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          {preview ? "EDIT" : "PREVIEW"}
        </button>
      </div>
      {preview ? (
        <div className="border p-2 min-h-[240px]" style={{ borderColor: colors.border }}>
          {renderMarkdown(draft.body, colors)}
        </div>
      ) : (
        <textarea
          id="thesis-body"
          value={draft.body}
          onChange={(e) => set("body")(e.target.value)}
          rows={16}
          className="w-full border px-2 py-1 text-[10px] font-mono outline-none"
          style={inputStyle}
        />
      )}

      <div className="flex gap-2 mt-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !draft.symbol.trim()}
          className="text-[8px] px-2 py-1 border font-bold disabled:opacity-40"
          style={{ borderColor: colors.accent, color: colors.accent, background: "#ff990015" }}
        >
          {saving ? "SAVING…" : isNew ? "CREATE THESIS" : "SAVE CHANGES"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[8px] px-2 py-1 border font-bold"
          style={{ borderColor: colors.border, color: colors.textSecondary }}
        >
          CANCEL
        </button>
      </div>
    </div>
  );
}
