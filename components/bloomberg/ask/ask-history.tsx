"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { type FormEvent, useState } from "react";
import {
  type AskSessionList,
  type AskSessionMeta,
  type AskTrashedSession,
  fetchSession,
  fetchSessions,
  fetchTrash,
  groupSessions,
  matchesFilter,
  pinSession,
  purgeSession,
  removeSession,
  restoreSession,
  setSessionStore,
} from "./sessions";
import { askArchiveNoteAtom, askSessionIdAtom } from "./store";
import type { AskMessage, ThemeColors } from "./types";

interface Props {
  colors: ThemeColors;
  busy: boolean;
  /** Put a saved conversation on screen. */
  onOpen: (id: string, messages: AskMessage[]) => void;
  onClose: () => void;
  /**
   * `drop` — under the ASK bar, over the page: storage on top, a short list.
   * `tab` — the HISTORY tab of the ASK column: the list fills it, storage folds away.
   */
  mode?: "drop" | "tab";
  /** The conversation on screen was deleted — the panel starts a new one. */
  onDeletedCurrent?: () => void;
}

const STORES: { id: "drive" | "local" | "off"; label: string; title: string }[] = [
  {
    id: "drive",
    label: "GOOGLE DRIVE",
    title: "โฟลเดอร์ Google Drive ที่พอร์ต sync อยู่ — เครื่องอื่นเห็นบทสนทนาเดียวกัน",
  },
  { id: "local", label: "THIS MACHINE", title: "โฟลเดอร์ข้อมูลของ app บนเครื่องนี้เท่านั้น" },
  { id: "off", label: "OFF", title: "ไม่เก็บลงไฟล์ — บทสนทนาอยู่แค่ใน tab นี้" },
];

/** "16:32" today, "5 Oct 16:32" otherwise. */
function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

/** The saved-conversation list, shared by HISTORY and the recent list of an empty chat. */
export function useAskSessions() {
  return useQuery<AskSessionList>({
    queryKey: ["ask-sessions"],
    queryFn: fetchSessions,
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * ASK → HISTORY: the saved conversations, and where this machine keeps them.
 *
 * Every conversation is written to a file after each answer — in the Google
 * Drive folder the portfolio syncs through, or on this machine; never inside
 * the repository (backend/ask_sessions.py). STORAGE is this machine's own
 * setting (backend/.env), so one machine can keep its conversations to itself
 * while the other shares them. A pin is kept in the conversation's file.
 */
export function AskHistory({
  colors,
  busy,
  onOpen,
  onClose,
  mode = "drop",
  onDeletedCurrent,
}: Props) {
  const tab = mode === "tab";
  const client = useQueryClient();
  const current = useAtomValue(askSessionIdAtom);
  const saveNote = useAtomValue(askArchiveNoteAtom);
  const list = useAskSessions();
  const [note, setNote] = useState<string | null>(null);
  const [storageOpen, setStorageOpen] = useState(!tab);
  const [folderOpen, setFolderOpen] = useState(false);
  const [folder, setFolder] = useState("");
  const [filter, setFilter] = useState("");
  const [working, setWorking] = useState(false);
  // One row at a time asks "delete?" before anything moves.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const trash = useQuery<AskTrashedSession[]>({
    queryKey: ["ask-sessions-trash"],
    queryFn: fetchTrash,
    enabled: trashOpen,
    staleTime: 15_000,
    retry: false,
  });

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["ask-sessions"] }),
      client.invalidateQueries({ queryKey: ["ask-sessions-trash"] }),
    ]);
  const remove = (s: AskSessionMeta) =>
    run(async () => {
      setConfirming(null);
      const error = await removeSession(s.id);
      if (!error && s.id === current) onDeletedCurrent?.();
      return error;
    });
  const emptyTrash = (items: AskTrashedSession[]) =>
    run(async () => {
      setConfirming(null);
      for (const s of items) {
        const error = await purgeSession(s.id);
        if (error) return error;
      }
      return null;
    });
  const run = async (action: () => Promise<string | null>) => {
    setWorking(true);
    let error: string | null;
    try {
      error = await action();
    } catch (err) {
      error = err instanceof Error ? err.message : "failed";
    }
    setWorking(false);
    setNote(error);
    await refresh();
    return !error;
  };

  const open = (s: AskSessionMeta) =>
    run(async () => {
      onOpen(s.id, await fetchSession(s.id));
      onClose();
      return null;
    });
  const saveFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!folder.trim()) return;
    if (await run(() => setSessionStore({ dir: folder.trim() }))) {
      setFolder("");
      setFolderOpen(false);
    }
  };

  const data = list.data;
  const dim = { color: colors.textSecondary };
  const label = "text-[8px] font-bold tracking-widest w-14 shrink-0";
  const shown = (data?.sessions ?? []).filter((s) => matchesFilter(s, filter));
  const groups = groupSessions(shown);
  const message = note ?? saveNote ?? data?.reason;

  const trashButton = (
    <button
      type="button"
      aria-pressed={trashOpen}
      onClick={() => {
        setConfirming(null);
        setTrashOpen((v) => !v);
      }}
      className="shrink-0 tracking-widest hover:opacity-70"
      style={{ color: trashOpen ? colors.accent : colors.textSecondary }}
      title="แชตที่ลบแล้ว — กู้คืน หรือลบถาวร"
    >
      TRASH{trashOpen && trash.data ? ` (${trash.data.length})` : ""}
    </button>
  );

  const storage = (
    <>
      <div className="flex items-center gap-2">
        <span className={label} style={dim}>
          STORAGE
        </span>
        <div className="flex flex-wrap gap-x-3 flex-1 min-w-0">
          {STORES.map((s) => {
            const on = data?.store === s.id;
            const missing = s.id === "drive" && data && !data.drive_dir;
            return (
              <button
                key={s.id}
                type="button"
                aria-pressed={on}
                disabled={working || !data || !!missing}
                onClick={() => run(() => setSessionStore({ store: s.id }))}
                className="hover:opacity-70 disabled:opacity-30"
                style={{ color: on ? colors.accent : colors.text, fontWeight: on ? 700 : 400 }}
                title={missing ? "ไม่พบโฟลเดอร์ Google Drive บนเครื่องนี้" : s.title}
              >
                {on ? "●" : "○"} {s.label}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={data?.store === "custom"}
            onClick={() => setFolderOpen((v) => !v)}
            className="hover:opacity-70"
            style={{
              color: data?.store === "custom" ? colors.accent : colors.text,
              fontWeight: data?.store === "custom" ? 700 : 400,
            }}
            title="เลือกโฟลเดอร์เอง — ต้องอยู่นอก repo"
          >
            {data?.store === "custom" ? "●" : "○"} FOLDER {folderOpen ? "▾" : "▸"}
          </button>
        </div>
        {!tab && trashButton}
        {!tab && (
          <button type="button" onClick={onClose} className="shrink-0 hover:opacity-70" style={dim}>
            ✕
          </button>
        )}
      </div>

      {folderOpen && (
        <form onSubmit={saveFolder} className="flex items-center gap-2">
          <span className={label} style={dim}>
            FOLDER
          </span>
          <input
            type="text"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={data?.local_dir ?? "Full path, outside the repository"}
            spellCheck={false}
            autoComplete="off"
            maxLength={400}
            aria-label="Folder for saved conversations"
            className="bg-transparent border px-1 outline-none placeholder:opacity-40 min-w-0 flex-1"
            style={{ borderColor: colors.border, color: colors.text }}
          />
          <button
            type="submit"
            disabled={working || !folder.trim()}
            className="font-bold shrink-0 hover:opacity-70 disabled:opacity-30"
            style={{ color: colors.accent }}
          >
            SAVE
          </button>
        </form>
      )}

      <div className="flex items-center gap-2">
        <span className={label} style={dim}>
          SAVED IN
        </span>
        <span className="truncate flex-1 min-w-0" style={dim} title={data?.dir ?? undefined}>
          {list.isLoading
            ? "checking…"
            : list.isError
              ? "backend ไม่ตอบ"
              : (data?.dir ?? "— not saved to a file; this tab only")}
        </span>
        {data?.device && (
          <span className="shrink-0" style={dim} title="ชื่อเครื่องนี้ในไฟล์ที่บันทึก">
            {data.device}
          </span>
        )}
      </div>
    </>
  );

  return (
    <div
      className={`flex flex-col gap-1 px-2 py-1 text-[9px] font-mono ${tab ? "h-full min-h-0" : "border-b"}`}
      style={{
        backgroundColor: tab ? undefined : colors.surface,
        borderColor: colors.border,
        color: colors.text,
      }}
    >
      {tab && (
        <div className="shrink-0 flex items-center gap-2 pb-1">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="ค้นหาแชตเก่าจากคำถามแรก…"
            spellCheck={false}
            autoComplete="off"
            maxLength={200}
            aria-label="Filter saved conversations"
            className="bg-transparent border-b px-1 py-0.5 text-[10px] outline-none placeholder:opacity-40 min-w-0 flex-1"
            style={{ borderColor: colors.border, color: colors.text }}
          />
          <span className="shrink-0" style={dim}>
            {data ? `${shown.length}/${data.sessions.length}` : ""}
          </span>
          {trashButton}
          <button
            type="button"
            aria-pressed={storageOpen}
            onClick={() => setStorageOpen((v) => !v)}
            className="shrink-0 tracking-widest hover:opacity-70"
            style={{ color: storageOpen ? colors.accent : colors.textSecondary }}
            title="ที่เก็บบทสนทนาของเครื่องนี้"
          >
            STORAGE {storageOpen ? "▾" : "▸"}
          </button>
        </div>
      )}

      {storageOpen && <div className="shrink-0 flex flex-col gap-1">{storage}</div>}

      {message && (
        <div className="shrink-0" style={{ color: "#ffc107" }}>
          {message}
        </div>
      )}

      <div
        className={`flex flex-col overflow-y-auto ${tab ? "flex-1 min-h-0" : "max-h-[40vh]"}`}
        style={{ scrollbarWidth: "thin", scrollbarColor: "#333 transparent" }}
      >
        {trashOpen ? (
          <TrashList
            colors={colors}
            items={trash.data}
            loading={trash.isLoading}
            error={trash.error instanceof Error ? trash.error.message : null}
            working={working}
            confirming={confirming}
            setConfirming={setConfirming}
            onRestore={(s) => run(() => restoreSession(s.id))}
            onPurge={(s) =>
              run(() => {
                setConfirming(null);
                return purgeSession(s.id);
              })
            }
            onEmpty={emptyTrash}
          />
        ) : (
          <>
            {data && data.sessions.length === 0 && data.dir && (
              <span className="py-1" style={dim}>
                ยังไม่มีบทสนทนาที่บันทึกไว้ — จะถูกบันทึกหลังคำตอบแรกจบ
              </span>
            )}
            {data && data.sessions.length > 0 && shown.length === 0 && (
              <span className="py-1" style={dim}>
                ไม่มีแชตที่คำถามแรกตรงกับ “{filter}”
              </span>
            )}
            {groups.map(([group, sessions]) => (
              <div key={group} className="flex flex-col">
                <span className="pt-2 pb-0.5 text-[8px] font-bold tracking-widest" style={dim}>
                  {group}
                </span>
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    colors={colors}
                    current={s.id === current}
                    device={data?.device ?? null}
                    busy={busy}
                    working={working}
                    onOpen={() => open(s)}
                    onPin={() => run(() => pinSession(s.id, !s.pinned))}
                    confirming={confirming === s.id}
                    onAskRemove={() => setConfirming(s.id)}
                    onCancelRemove={() => setConfirming(null)}
                    onRemove={() => remove(s)}
                  />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  s,
  colors,
  current,
  device,
  busy,
  working,
  onOpen,
  onPin,
  confirming,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  s: AskSessionMeta;
  colors: ThemeColors;
  current: boolean;
  device: string | null;
  busy: boolean;
  working: boolean;
  onOpen: () => void;
  onPin: () => void;
  confirming: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const dim = { color: colors.textSecondary };
  if (confirming) {
    return (
      <div
        className="flex items-baseline gap-2 py-0.5 border-t"
        style={{ borderColor: colors.border }}
      >
        <span className="truncate flex-1 min-w-0 text-[10px]" style={{ color: colors.text }}>
          ลบ “{s.title || "(no question)"}”{current ? " — แชตที่เปิดอยู่จะเริ่มใหม่" : ""}?
        </span>
        <button
          type="button"
          disabled={working}
          onClick={onRemove}
          className="shrink-0 font-bold tracking-widest hover:opacity-70 disabled:opacity-30"
          style={{ color: "#ef5350" }}
          title="ย้ายไปถังขยะ — กู้คืนได้จาก TRASH"
        >
          DELETE
        </button>
        <button
          type="button"
          onClick={onCancelRemove}
          className="shrink-0 tracking-widest hover:opacity-70"
          style={dim}
        >
          CANCEL
        </button>
      </div>
    );
  }
  return (
    <div
      className="group flex items-baseline gap-2 py-0.5 border-t"
      style={{ borderColor: colors.border }}
    >
      <button
        type="button"
        aria-pressed={current}
        disabled={busy || working}
        onClick={onOpen}
        className="flex items-baseline gap-2 flex-1 min-w-0 text-left hover:opacity-70 disabled:opacity-40"
        title={
          busy
            ? "รอคำตอบที่กำลังมาให้จบก่อน"
            : `${s.title}\n${s.questions} คำถาม · บันทึกล่าสุดจากเครื่อง ${s.device ?? "?"}`
        }
      >
        <span
          className="truncate flex-1 min-w-0 text-[10px]"
          style={{ color: current ? colors.accent : colors.text, fontWeight: current ? 700 : 400 }}
        >
          {current ? "▸ " : ""}
          {s.title || "(no question)"}
        </span>
        {s.private && (
          <span
            className="shrink-0"
            style={{ color: "#ffc107" }}
            title="อ่านข้อมูลส่วนตัว (พอร์ต / thesis)"
          >
            P
          </span>
        )}
        {s.device && s.device !== device && (
          <span className="shrink-0" style={dim}>
            {s.device}
          </span>
        )}
        <span className="shrink-0" style={dim}>
          {s.questions}Q
        </span>
        <span className="shrink-0 w-[62px] text-right" style={dim}>
          {when(s.updated_at)}
        </span>
      </button>
      <button
        type="button"
        aria-pressed={s.pinned}
        disabled={working}
        onClick={onPin}
        className={`shrink-0 hover:opacity-70 disabled:opacity-30 ${s.pinned ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
        style={{ color: s.pinned ? colors.accent : colors.textSecondary }}
        title={s.pinned ? "เลิกปักหมุด" : "ปักหมุดไว้บนสุด — เห็นทั้งสองเครื่อง"}
        aria-label={`${s.pinned ? "Unpin" : "Pin"} conversation ${s.title}`}
      >
        {s.pinned ? "★" : "☆"}
      </button>
      <button
        type="button"
        // The open conversation can go too — not while its answer is still coming.
        disabled={working || (current && busy)}
        onClick={onAskRemove}
        className="shrink-0 opacity-40 group-hover:opacity-100 focus:opacity-100 hover:opacity-70 disabled:opacity-30"
        style={dim}
        title="ลบ — ย้ายไปถังขยะ (TRASH) กู้คืนได้"
        aria-label={`Delete conversation ${s.title}`}
      >
        ✕
      </button>
    </div>
  );
}

/** HISTORY → TRASH: what was deleted, to restore or to erase for good. */
function TrashList({
  colors,
  items,
  loading,
  error,
  working,
  confirming,
  setConfirming,
  onRestore,
  onPurge,
  onEmpty,
}: {
  colors: ThemeColors;
  items: AskTrashedSession[] | undefined;
  loading: boolean;
  error: string | null;
  working: boolean;
  confirming: string | null;
  setConfirming: (id: string | null) => void;
  onRestore: (s: AskTrashedSession) => void;
  onPurge: (s: AskTrashedSession) => void;
  onEmpty: (items: AskTrashedSession[]) => void;
}) {
  const dim = { color: colors.textSecondary };
  const red = { color: "#ef5350" };
  if (loading) return <span style={dim}>checking…</span>;
  if (error) return <span style={{ color: "#ffc107" }}>{error}</span>;
  if (!items?.length) {
    return (
      <span className="py-1" style={dim}>
        ถังขยะว่าง — แชตที่ลบจะมาอยู่ที่นี่ และกู้คืนได้
      </span>
    );
  }
  const emptying = confirming === "*";
  return (
    <>
      <div className="flex items-baseline gap-2 pt-1 pb-0.5 text-[8px] font-bold tracking-widest">
        <span className="flex-1" style={dim}>
          DELETED · {items.length}
        </span>
        {emptying ? (
          <>
            <span style={{ color: colors.text }}>ลบถาวรทั้ง {items.length} แชต? กู้คืนไม่ได้</span>
            <button
              type="button"
              disabled={working}
              onClick={() => onEmpty(items)}
              className="hover:opacity-70 disabled:opacity-30"
              style={red}
            >
              ERASE ALL
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="hover:opacity-70"
              style={dim}
            >
              CANCEL
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={working}
            onClick={() => setConfirming("*")}
            className="hover:opacity-70 disabled:opacity-30"
            style={red}
            title="ลบทุกแชตในถังขยะถาวร"
          >
            EMPTY TRASH
          </button>
        )}
      </div>
      {items.map((s) => (
        <div
          key={s.id}
          className="flex items-baseline gap-2 py-0.5 border-t"
          style={{ borderColor: colors.border }}
        >
          {confirming === s.id ? (
            <>
              <span className="truncate flex-1 min-w-0 text-[10px]" style={{ color: colors.text }}>
                ลบ “{s.title || "(no question)"}” ถาวร? กู้คืนไม่ได้
              </span>
              <button
                type="button"
                disabled={working}
                onClick={() => onPurge(s)}
                className="shrink-0 font-bold tracking-widest hover:opacity-70 disabled:opacity-30"
                style={red}
              >
                ERASE
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="shrink-0 tracking-widest hover:opacity-70"
                style={dim}
              >
                CANCEL
              </button>
            </>
          ) : (
            <>
              <span
                className="truncate flex-1 min-w-0 text-[10px]"
                style={dim}
                title={`${s.title}\n${s.questions} คำถาม`}
              >
                {s.title || "(no question)"}
              </span>
              <span className="shrink-0" style={dim} title="เวลาที่ลบ">
                {when(s.deleted_at)}
              </span>
              <button
                type="button"
                disabled={working}
                onClick={() => onRestore(s)}
                className="shrink-0 tracking-widest hover:opacity-70 disabled:opacity-30"
                style={{ color: colors.accent }}
                title="กู้คืนกลับไปที่ HISTORY"
              >
                RESTORE
              </button>
              <button
                type="button"
                disabled={working}
                onClick={() => setConfirming(s.id)}
                className="shrink-0 tracking-widest hover:opacity-70 disabled:opacity-30"
                style={red}
                title="ลบถาวร — กู้คืนไม่ได้"
              >
                ERASE
              </button>
            </>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * The newest saved conversations under the starters of an empty chat — so an
 * earlier one is a click away without opening HISTORY. Renders nothing when
 * there are none.
 */
export function AskRecent({
  colors,
  busy,
  onOpen,
  onAll,
  limit = 6,
}: {
  colors: ThemeColors;
  busy: boolean;
  onOpen: (id: string, messages: AskMessage[]) => void;
  onAll: () => void;
  limit?: number;
}) {
  const list = useAskSessions();
  const [error, setError] = useState<string | null>(null);
  const sessions = groupSessions(list.data?.sessions ?? [])
    .flatMap(([, s]) => s)
    .slice(0, limit);
  if (!sessions.length) return null;
  const dim = { color: colors.textSecondary };
  return (
    <div className="flex flex-col gap-0.5 pt-3">
      <div
        className="flex items-baseline justify-between text-[8px] font-bold tracking-widest"
        style={dim}
      >
        <span>RECENT CHATS</span>
        <button
          type="button"
          onClick={onAll}
          className="tracking-widest hover:opacity-70"
          style={{ color: colors.accent }}
        >
          ALL {list.data?.sessions.length ?? ""} ▸
        </button>
      </div>
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          disabled={busy}
          onClick={async () => {
            try {
              setError(null);
              onOpen(s.id, await fetchSession(s.id));
            } catch (err) {
              setError(err instanceof Error ? err.message : "failed");
            }
          }}
          className="flex items-baseline gap-2 text-left hover:opacity-70 disabled:opacity-40"
          title={`${s.title}\n${s.questions} คำถาม`}
        >
          <span className="shrink-0 w-3" style={{ color: colors.accent }}>
            {s.pinned ? "★" : "›"}
          </span>
          <span className="truncate flex-1 min-w-0" style={{ color: colors.text }}>
            {s.title || "(no question)"}
          </span>
          <span className="shrink-0 text-[9px]" style={dim}>
            {when(s.updated_at)}
          </span>
        </button>
      ))}
      {error && <span style={{ color: "#ffc107" }}>{error}</span>}
    </div>
  );
}
