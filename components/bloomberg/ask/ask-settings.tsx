"use client";

import { type FormEvent, useState } from "react";
import type { AskChoice, AskStatus, ThemeColors } from "./types";
import { useAskModels, useSaveAskKey } from "./useAskConversation";

interface Props {
  colors: ThemeColors;
  status: AskStatus;
  choice: AskChoice;
  onChoose: (choice: AskChoice) => void;
  onClose: () => void;
}

/**
 * ASK → MODEL: which provider and which of its models answer, and where a
 * provider's API key is entered. Three rows, one per decision.
 *
 * The key is write-only. It goes to backend/.env on this machine; the backend
 * reports only whether one is there, so nothing here can show it again and it
 * is never kept in the browser. Provider and model are a preference of this
 * browser (localStorage) and travel with each question.
 */
export function AskSettings({ colors, status, onChoose, onClose }: Props) {
  const provider = status.providers.find((p) => p.id === status.provider_id) ?? status.providers[0];
  const live = useAskModels(provider?.id ?? null, !!provider?.configured);
  const saveKey = useSaveAskKey();

  // One box: typing narrows the list, Enter uses what was typed as the model id.
  const [modelText, setModelText] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  if (!provider) return null;

  const models = [...new Set([...provider.models, ...(live.data?.models ?? [])])];
  const q = modelText.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;

  const pickProvider = (id: string) => {
    setModelText("");
    setKeyDraft("");
    setUrlDraft("");
    setNote(null);
    onChoose({ provider: id, model: null });
  };
  const pickModel = (model: string) => {
    setModelText("");
    onChoose({ provider: provider.id, model });
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || (!keyDraft.trim() && !urlDraft.trim())) return;
    setSaving(true);
    const error = await saveKey(provider.id, keyDraft, urlDraft);
    setSaving(false);
    setNote(error ? { ok: false, text: error } : { ok: true, text: "Saved" });
    if (!error) {
      setKeyDraft("");
      setUrlDraft("");
    }
  };

  const dim = { color: colors.textSecondary };
  const label = "text-[8px] font-bold tracking-widest w-14 shrink-0";
  const box = "bg-transparent border px-1 outline-none placeholder:opacity-40 min-w-0";
  const boxStyle = { borderColor: colors.border, color: colors.text };
  const keyState = provider.has_key ? "SET" : provider.configured ? "OPTIONAL" : "NOT SET";

  return (
    <div
      className="flex flex-col gap-1 px-2 py-1 border-b text-[9px] font-mono"
      style={{ backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }}
    >
      <div className="flex items-center gap-2">
        <span className={label} style={dim}>
          PROVIDER
        </span>
        <div className="flex flex-wrap gap-x-3 flex-1 min-w-0">
          {status.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickProvider(p.id)}
              className="hover:opacity-70"
              style={{
                color:
                  p.id === provider.id ? colors.accent : p.configured ? colors.text : dim.color,
                fontWeight: p.id === provider.id ? 700 : 400,
              }}
              title={p.configured ? "API key set" : "No API key"}
            >
              {p.configured ? "●" : "○"} {p.label.toUpperCase()}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose} className="shrink-0 hover:opacity-70" style={dim}>
          ✕
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (modelText.trim()) pickModel(modelText.trim());
        }}
        className="flex items-center gap-2"
      >
        <span className={label} style={dim}>
          MODEL
        </span>
        <div
          className="flex flex-wrap gap-x-3 flex-1 min-w-0 max-h-[26px] overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#333 transparent" }}
        >
          {shown.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => pickModel(m)}
              className="hover:opacity-70"
              style={{
                color: m === status.model ? colors.accent : colors.text,
                fontWeight: m === status.model ? 700 : 400,
              }}
            >
              {m}
            </button>
          ))}
          {status.model && !models.includes(status.model) && (
            <span style={{ color: colors.accent, fontWeight: 700 }}>{status.model}</span>
          )}
          {!status.model && shown.length === 0 && !live.isFetching && (
            <span style={{ color: "#ffc107" }}>No model selected</span>
          )}
          {provider.configured && live.isFetching && <span style={dim}>Loading…</span>}
          {provider.configured && live.error && (
            <span style={{ color: "#ef5350" }} title={live.error.message}>
              Model list unavailable
            </span>
          )}
        </div>
        <input
          type="text"
          value={modelText}
          onChange={(e) => setModelText(e.target.value)}
          placeholder="Filter or enter model ID"
          title="Type to filter the list. Press Enter to use the text as the model ID."
          maxLength={120}
          spellCheck={false}
          className={`${box} w-40 shrink-0`}
          style={boxStyle}
        />
      </form>

      <form onSubmit={onSave} className="flex items-center gap-2">
        <span className={label} style={dim}>
          API KEY
        </span>
        <span
          className="shrink-0"
          style={{
            color: provider.has_key ? "#4caf50" : provider.configured ? dim.color : "#ffc107",
          }}
          title={`Stored as ${provider.key_env} in backend/.env on this machine. Never kept in the browser and never displayed again.${provider.base_url ? `\nEndpoint: ${provider.base_url}` : ""}`}
        >
          {keyState}
        </span>
        {provider.needs_url && (
          <input
            type="text"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder={provider.base_url || "Base URL, e.g. http://127.0.0.1:11434/v1"}
            title="Base URL of an OpenAI-compatible server"
            spellCheck={false}
            autoComplete="off"
            className={`${box} flex-1`}
            style={boxStyle}
          />
        )}
        <input
          type="password"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder={provider.has_key ? "Enter a new key to replace" : "Enter API key"}
          autoComplete="off"
          spellCheck={false}
          maxLength={400}
          aria-label={`${provider.label} API key`}
          className={`${box} flex-1`}
          style={boxStyle}
        />
        {note && (
          <span
            className="shrink-0 truncate max-w-[40%]"
            style={{ color: note.ok ? "#4caf50" : "#ef5350" }}
            title={note.text}
          >
            {note.text}
          </span>
        )}
        <button
          type="submit"
          disabled={saving || (!keyDraft.trim() && !urlDraft.trim())}
          className="font-bold shrink-0 hover:opacity-70 disabled:opacity-30"
          style={{ color: colors.accent }}
        >
          {saving ? "SAVING" : "SAVE"}
        </button>
      </form>
    </div>
  );
}
