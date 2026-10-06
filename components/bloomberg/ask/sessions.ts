import type { AskMessage } from "./types.ts";

/**
 * Saved conversations — the client side of backend/ask_sessions.py.
 *
 * The page keeps the conversation it is in (persist.ts, sessionStorage). After
 * every answer the whole of it is also written to a file on this machine or in
 * the cloud folder, outside the repository, so it can be opened again later or
 * from the other machine. Where that is, is this machine's own setting
 * (ASK → HISTORY → STORAGE).
 */

/** `ASK_API` + "/sessions" — written out so this file imports no state and runs under `node --test`. */
export const SESSIONS_API = "/api/news/ask/sessions";

export interface AskSessionMeta {
  id: string;
  title: string;
  created_at: string | null;
  updated_at: string | null;
  questions: number;
  private: boolean;
  /** Kept at the top of HISTORY. Stored in the conversation's file. */
  pinned: boolean;
  /** The machine that saved it last. */
  device: string | null;
  page: string | null;
}

export interface AskSessionStore {
  /** In effect: where conversations are written. */
  store: "drive" | "local" | "custom" | "off";
  /** As set: auto | drive | local | off | custom. */
  choice: string;
  dir: string | null;
  /** Why `store` is not what was asked for, or why the folder cannot be used. */
  reason: string | null;
  /** The Google Drive folder, when this machine has one. */
  drive_dir: string | null;
  local_dir: string;
  device: string;
}

export interface AskSessionList extends AskSessionStore {
  sessions: AskSessionMeta[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * `YYYYMMDD-HHMMSS-xxxxxx`, local time. The name of the file: it sorts by when
 * the conversation started, and the tail keeps two started in one second apart.
 */
export function newSessionId(now: Date = new Date(), random: () => number = Math.random): string {
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const tail = Math.floor(random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
  return `${day}-${time}-${tail}`;
}

/** What tells one state of a conversation from the next — so an unchanged one is not written again. */
export function sessionSignature(id: string, messages: AskMessage[]): string {
  const last = messages[messages.length - 1];
  return `${id}:${messages.length}:${last?.content.length ?? 0}:${last?.error ?? ""}`;
}

async function reason(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error ?? `HTTP ${res.status}`;
}

/** Write the conversation to its file. Resolves to why it could not, or null. */
export async function archiveSession(
  id: string,
  messages: AskMessage[],
  page: string | null
): Promise<string | null> {
  try {
    const res = await fetch(`${SESSIONS_API}/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, page }),
    });
    // 409 = history is off on this machine: not a failure to report.
    return res.ok || res.status === 409 ? null : await reason(res);
  } catch {
    return "backend ไม่ตอบ — บทสนทนายังไม่ได้บันทึกลงไฟล์";
  }
}

export async function fetchSession(id: string): Promise<AskMessage[]> {
  const res = await fetch(`${SESSIONS_API}/${id}`);
  if (!res.ok) throw new Error(await reason(res));
  return ((await res.json()) as { messages: AskMessage[] }).messages;
}

export async function fetchSessions(): Promise<AskSessionList> {
  const res = await fetch(SESSIONS_API);
  if (!res.ok) throw new Error(await reason(res));
  return res.json();
}

/** Move a conversation out of the list (the backend keeps the files in `_deleted`). */
export async function removeSession(id: string): Promise<string | null> {
  const res = await fetch(`${SESSIONS_API}/${id}`, { method: "DELETE" });
  return res.ok ? null : await reason(res);
}

/** A deleted conversation: the list row plus when it went in the trash. */
export interface AskTrashedSession extends AskSessionMeta {
  deleted_at: string | null;
}

export async function fetchTrash(): Promise<AskTrashedSession[]> {
  const res = await fetch(`${SESSIONS_API}/trash`);
  if (!res.ok) throw new Error(await reason(res));
  return ((await res.json()) as { sessions: AskTrashedSession[] }).sessions;
}

/** Back from the trash into the list. */
export async function restoreSession(id: string): Promise<string | null> {
  const res = await fetch(`${SESSIONS_API}/trash/${id}/restore`, { method: "POST" });
  return res.ok ? null : await reason(res);
}

/** Erase for good — the backend takes only what is already in the trash. */
export async function purgeSession(id: string): Promise<string | null> {
  const res = await fetch(`${SESSIONS_API}/trash/${id}`, { method: "DELETE" });
  return res.ok ? null : await reason(res);
}

export async function pinSession(id: string, pinned: boolean): Promise<string | null> {
  const res = await fetch(`${SESSIONS_API}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
  return res.ok ? null : await reason(res);
}

export type SessionGroup =
  | "PINNED"
  | "TODAY"
  | "YESTERDAY"
  | "LAST 7 DAYS"
  | "LAST 30 DAYS"
  | "EARLIER";

/**
 * HISTORY's sections, in order: pinned first, then by when each was last added
 * to. Pure — `now` is a parameter so it can be tested.
 */
export function groupSessions(
  sessions: AskSessionMeta[],
  now: Date = new Date()
): [SessionGroup, AskSessionMeta[]][] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const day = 86_400_000;
  const groups = new Map<SessionGroup, AskSessionMeta[]>();
  const put = (g: SessionGroup, s: AskSessionMeta) => groups.set(g, [...(groups.get(g) ?? []), s]);
  const sorted = [...sessions].sort((a, b) =>
    (b.updated_at ?? b.created_at ?? "").localeCompare(a.updated_at ?? a.created_at ?? "")
  );
  for (const s of sorted) {
    if (s.pinned) {
      put("PINNED", s);
      continue;
    }
    const t = new Date(s.updated_at ?? s.created_at ?? 0).getTime();
    if (Number.isNaN(t) || t < today - 29 * day) put("EARLIER", s);
    else if (t >= today) put("TODAY", s);
    else if (t >= today - day) put("YESTERDAY", s);
    else if (t >= today - 6 * day) put("LAST 7 DAYS", s);
    else put("LAST 30 DAYS", s);
  }
  const order: SessionGroup[] = [
    "PINNED",
    "TODAY",
    "YESTERDAY",
    "LAST 7 DAYS",
    "LAST 30 DAYS",
    "EARLIER",
  ];
  return order.filter((g) => groups.has(g)).map((g) => [g, groups.get(g) ?? []]);
}

/** Every word in the title — HISTORY's filter box. */
export function matchesFilter(s: AskSessionMeta, filter: string): boolean {
  const title = s.title.toLowerCase();
  return filter
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => title.includes(w));
}

/** Set where this machine keeps conversations: a store, or an explicit folder. */
export async function setSessionStore(
  choice: { store: string } | { dir: string }
): Promise<string | null> {
  const res = await fetch(`${SESSIONS_API}/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(choice),
  });
  return res.ok ? null : await reason(res);
}
