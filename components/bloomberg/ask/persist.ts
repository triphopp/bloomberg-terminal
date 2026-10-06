import type { AskMessage } from "./types.ts";

/**
 * The conversation this tab is in, across a reload — sessionStorage: F5, a dev
 * rebuild or a frontend restart keeps it on screen; closing the tab ends it.
 *
 * This is the working copy, not the record. The record is a file per
 * conversation, outside the repository (sessions.ts → backend/ask_sessions.py),
 * which is what HISTORY lists. The two are kept apart on purpose: this one must
 * work with the backend down and needs no setup; that one is where each machine
 * decides for itself whether conversations leave it.
 *
 * An answer is a reading of "now" — prices, headlines — and one read later
 * would look as current as the day it was written, so every question carries
 * the time it was asked (`at`).
 *
 * `restore` and `forStorage` are pure; the two functions below them touch storage.
 */

const KEY = "bloomberg_ask_conversation";

/** Shown on an answer that a reload cut off. */
export const CUT_BY_RELOAD = "การตอบถูกตัดเพราะหน้าถูกโหลดใหม่ — กด ASK AGAIN เพื่อถามอีกครั้ง";

/** A stored conversation made safe to show: anything that is not a message is dropped. */
export function restore(raw: unknown): AskMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: AskMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as AskMessage;
    if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") continue;
    if (m.role === "assistant" && m.pending) {
      // It was still streaming when the page went away. The stream is gone.
      out.push({ ...m, pending: false, status: null, error: m.error ?? CUT_BY_RELOAD });
    } else {
      out.push(m);
    }
  }
  // A question with nothing after it (saved between the two) gets its answer slot.
  if (out.length && out[out.length - 1].role === "user") {
    out.push({ role: "assistant", content: "", error: CUT_BY_RELOAD });
  }
  return out;
}

/** The conversation without its pictures — what is stored when the full one does not fit. */
export function forStorage(messages: AskMessage[], pictures: boolean): AskMessage[] {
  if (pictures) return messages;
  return messages.map((m) => {
    if (!m.images?.length) return m;
    const { images, ...rest } = m;
    return { ...rest, lostImages: images.length };
  });
}

/** The conversation this tab was in, and the file it is saved to (sessions.ts). */
export function loadConversation(): { id: string | null; messages: AskMessage[] } {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { id: null, messages: [] };
    const saved = JSON.parse(raw) as { id?: unknown; messages?: unknown };
    const messages = restore(saved.messages);
    return { id: messages.length && typeof saved.id === "string" ? saved.id : null, messages };
  } catch {
    return { id: null, messages: [] };
  }
}

export function saveConversation(messages: AskMessage[], id: string | null = null): void {
  try {
    if (!messages.length) {
      sessionStorage.removeItem(KEY);
      return;
    }
    for (const pictures of [true, false]) {
      try {
        sessionStorage.setItem(
          KEY,
          JSON.stringify({ v: 2, id, messages: forStorage(messages, pictures) })
        );
        return;
      } catch {
        /* over the quota with pictures — try once more without them */
      }
    }
  } catch {
    /* storage unavailable (private window, blocked site data): the page works without it */
  }
}
