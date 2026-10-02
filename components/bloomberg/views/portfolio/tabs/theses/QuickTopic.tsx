"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Colors } from "../../helpers";
import { useThesisList } from "./ThesisNavigator";
import { DEFAULT_KINDS, facet, kindOf } from "./nav-filter";

/** A question or a tracked number about something that has no thesis yet — a
 *  rate path, a fund, an industry. Rather than leave it attached to nothing,
 *  open the subject here with just a short name and a kind: an empty draft
 *  thesis that the text can be written into later, or never. */
export function QuickTopic({
  colors,
  onCreated,
}: {
  colors: Colors;
  onCreated: (thesisId: string) => void;
}) {
  const qc = useQueryClient();
  const { data } = useThesisList();
  const kinds = [
    ...new Set([...DEFAULT_KINDS, ...facet(data?.theses ?? [], kindOf).map(([k]) => k)]),
  ];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("macro");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const field = { background: colors.surface, borderColor: colors.border, color: colors.text };

  const create = async () => {
    setBusy(true);
    const r = await fetch("/api/v2/theses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: name.trim(), title: name.trim(), kind, status: "draft" }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setErr(typeof d?.detail === "string" ? d.detail : `HTTP ${r.status}`);
    await qc.invalidateQueries({ queryKey: ["theses"] });
    setOpen(false);
    setName("");
    setErr("");
    onCreated(d.thesis.id);
  };

  if (!open)
    return (
      <button
        type="button"
        className="px-1.5 border hover:opacity-80"
        style={{ borderColor: colors.border, color: colors.accent }}
        onClick={() => setOpen(true)}
      >
        + หัวข้อใหม่
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="ชื่อสั้น เช่น TH-RATES"
        aria-label="ชื่อสั้นของหัวข้อ"
        className="px-1.5 py-0.5 border outline-none font-mono w-40"
        style={field}
      />
      <input
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        list="quick-topic-kinds"
        aria-label="kind"
        className="px-1.5 py-0.5 border outline-none w-24"
        style={field}
      />
      <datalist id="quick-topic-kinds">
        {kinds.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <button
        type="button"
        disabled={busy || !name.trim()}
        className="px-1.5 border font-bold disabled:opacity-40"
        style={{ borderColor: colors.border, color: colors.accent }}
        onClick={create}
      >
        สร้าง
      </button>
      <button
        type="button"
        className="px-1.5 border"
        style={{ borderColor: colors.border, color: colors.textSecondary }}
        onClick={() => setOpen(false)}
      >
        ยกเลิก
      </button>
      {err && <span style={{ color: "#f87171" }}>{err}</span>}
    </span>
  );
}
