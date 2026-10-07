"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { currentViewAtom } from "../atoms";
import { useWatchlistSymbols } from "../views/news/useWatchlistNews";
import { historyFor, historyIsPrivate } from "./history";
import { loadConversation, restore, saveConversation } from "./persist";
import { readScreen } from "./screen";
import { archiveSession, newSessionId, sessionSignature } from "./sessions";
import {
  ASK_API,
  askArchiveNoteAtom,
  askBusyAtom,
  askChoiceAtom,
  askMessageCountAtom,
  askMessagesAtom,
  askPageContextAtom,
  askSessionIdAtom,
  askTemporaryAtom,
} from "./store";
import type { AskChoice, AskEvent, AskMessage, AskStatus } from "./types";

// The request in flight, shared like the messages: every surface is a mount of
// one conversation, and STOP must work from whichever is open.
let activeRequest: AbortController | null = null;

/** Streamed events are applied in one state update per this many ms. */
const FLUSH_MS = 50;

function choiceQuery(choice: AskChoice): string {
  const qs = new URLSearchParams();
  if (choice.provider) qs.set("provider", choice.provider);
  if (choice.model) qs.set("model", choice.model);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/** Status of the chosen provider / model (or the backend default when nothing is chosen). */
export function useAskStatus(choice: AskChoice) {
  return useQuery<AskStatus>({
    queryKey: ["news-ask-status", choice.provider, choice.model],
    queryFn: async () => {
      const res = await fetch(`${ASK_API}${choiceQuery(choice)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** Model ids the saved key may use, asked of the provider itself. */
export function useAskModels(provider: string | null, enabled: boolean) {
  return useQuery<{ models: string[]; error?: string }>({
    queryKey: ["news-ask-models", provider],
    enabled: enabled && !!provider,
    staleTime: 10 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`${ASK_API}/models?provider=${encodeURIComponent(provider ?? "")}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      return body;
    },
  });
}

/** Save a provider's key / address to backend/.env. Resolves to an error text, or null. */
export function useSaveAskKey() {
  const client = useQueryClient();
  return useCallback(
    async (provider: string, apiKey: string, baseUrl: string): Promise<string | null> => {
      try {
        const res = await fetch(`${ASK_API}/key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            api_key: apiKey.trim() || null,
            base_url: baseUrl.trim() || null,
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) return body?.error ?? `HTTP ${res.status}`;
        await client.invalidateQueries({ queryKey: ["news-ask-status"] });
        await client.invalidateQueries({ queryKey: ["news-ask-models", provider] });
        return null;
      } catch {
        return "Backend unavailable";
      }
    },
    [client]
  );
}

function applyEvent(msg: AskMessage, ev: AskEvent): AskMessage {
  switch (ev.type) {
    case "status":
      return { ...msg, status: ev.text };
    case "token":
      return { ...msg, content: msg.content + ev.text, status: null };
    case "reset":
      return { ...msg, content: "" };
    case "tool":
      return { ...msg, tools: [...(msg.tools ?? []), { label: ev.label, detail: ev.detail }] };
    case "sources":
      return { ...msg, sources: ev.sources };
    case "error":
      return { ...msg, error: ev.text, status: null, pending: false };
    case "done":
      return { ...msg, model: ev.model, private: ev.private, status: null, pending: false };
    default:
      // An event this build does not know (backend newer than the page): skip it.
      return msg;
  }
}

/**
 * The conversation: messages, the request in flight, send / stop / clear. What
 * goes with a question besides its text is read when it is sent — the model
 * choice, the watchlist, the view on screen and what that view said about
 * itself (useAskContext) — so no caller passes any of it in.
 */
export function useAskConversation() {
  const store = useStore();
  const symbols = useWatchlistSymbols();
  const choice = useAtomValue(askChoiceAtom);
  const [messages, setMessages] = useAtom(askMessagesAtom);
  const [busy, setBusy] = useAtom(askBusyAtom);

  const patchLast = useCallback(
    (fn: (m: AskMessage) => AskMessage) =>
      setMessages((prev) =>
        prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1])] : prev
      ),
    [setMessages]
  );

  const ask = useCallback(
    // `base` is the conversation the question is added to: all of it, or — for
    // ASK AGAIN — what came before the question being asked again.
    async (question: string, images: string[] = [], base: AskMessage[] = messages) => {
      // A picture alone is a question too; the model still needs words to answer to.
      const q = question.trim() || (images.length ? "อธิบายรูปที่แนบ" : "");
      if (!q || busy) return;
      // The file this conversation is saved to gets its name with the first
      // question — a temporary chat has no file, so it gets no name.
      if (!store.get(askSessionIdAtom) && !store.get(askTemporaryAtom)) {
        store.set(askSessionIdAtom, newSessionId());
      }

      // Finished exchanges only (history.ts); pictures of earlier questions stay
      // on screen but are not sent again.
      const history = historyFor(base);
      const privateHistory = historyIsPrivate(base);

      setMessages([
        ...base,
        { role: "user", content: q, at: Date.now(), ...(images.length ? { images } : {}) },
        { role: "assistant", content: "", pending: true, status: "CONNECTING" },
      ]);
      setBusy(true);
      const controller = new AbortController();
      activeRequest = controller;

      // Tokens arrive 30–60 a second. One state update each re-rendered the
      // whole surface per token; they are applied together every FLUSH_MS.
      let queue: AskEvent[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (!queue.length) return;
        const batch = queue;
        queue = [];
        patchLast((m) => batch.reduce(applyEvent, m));
      };

      try {
        const page = store.get(askPageContextAtom);
        const res = await fetch(ASK_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: q,
            images,
            history,
            symbols,
            page: store.get(currentViewAtom),
            focus: page?.symbols ?? [],
            context: page?.note ?? null,
            // The view as the user sees it now; the model reads it only if it asks to.
            screen: readScreen() || null,
            private: privateHistory,
            // The file it is saved to: read_session reaches what history no longer carries.
            session: store.get(askSessionIdAtom),
            provider: choice.provider,
            model: choice.model,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame.trim();
            if (!line.startsWith("data:")) continue;
            try {
              queue.push(JSON.parse(line.slice(5)) as AskEvent);
            } catch {
              /* a malformed frame is dropped, the stream goes on */
            }
          }
          if (queue.length && timer === null) timer = setTimeout(flush, FLUSH_MS);
        }
        flush();
        // Stream closed without a done/error frame (backend restarted mid-answer).
        patchLast((m) =>
          m.pending ? { ...m, pending: false, status: null, error: "การเชื่อมต่อถูกตัดก่อนตอบจบ" } : m
        );
      } catch (err) {
        flush(); // keep what had arrived before the stop / failure
        const stopped = controller.signal.aborted;
        patchLast((m) => ({
          ...m,
          pending: false,
          status: null,
          error: stopped ? "หยุดแล้ว" : err instanceof Error ? err.message : "request failed",
        }));
      } finally {
        activeRequest = null;
        setBusy(false);
      }
    },
    [busy, messages, symbols, choice.provider, choice.model, store, setMessages, setBusy, patchLast]
  );

  /** The last question once more — after a stop, an error, or an answer worth a second try. */
  const again = useCallback(() => {
    if (busy) return;
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role !== "user") i--;
    if (i < 0) return;
    void ask(messages[i].content, messages[i].images ?? [], messages.slice(0, i));
  }, [busy, messages, ask]);

  const stop = useCallback(() => activeRequest?.abort(), []);
  /** A new conversation. The one on screen stays in its file (HISTORY). */
  const clear = useCallback(() => {
    activeRequest?.abort();
    store.set(askSessionIdAtom, null);
    store.set(askArchiveNoteAtom, null);
    store.set(askTemporaryAtom, false);
    setMessages([]);
    saveConversation([]); // forget it in this tab; its file stays
  }, [store, setMessages]);

  /**
   * Temporary chat on / off. On: a conversation already on screen is saved, so
   * a new, empty one starts. Off: what was asked so far is kept — it gets a
   * file now and is saved like any other (useAskPersistence).
   */
  const setTemporary = useCallback(
    (on: boolean) => {
      if (on) {
        if (store.get(askMessagesAtom).length) clear();
        store.set(askTemporaryAtom, true);
        return;
      }
      if (store.get(askMessagesAtom).length && !store.get(askSessionIdAtom)) {
        store.set(askSessionIdAtom, newSessionId());
      }
      store.set(askTemporaryAtom, false);
    },
    [store, clear]
  );

  /** Put a saved conversation on screen (HISTORY). It continues in the same file. */
  const openSaved = useCallback(
    (id: string, saved: AskMessage[]) => {
      if (busy) return;
      const restored = restore(saved);
      archived = sessionSignature(id, restored); // as it is in the file: nothing to write
      store.set(askSessionIdAtom, id);
      store.set(askArchiveNoteAtom, null);
      store.set(askTemporaryAtom, false);
      setMessages(restored);
    },
    [busy, store, setMessages]
  );

  return { messages, busy, ask, again, stop, clear, openSaved, setTemporary };
}

// The conversation as it was last written to its file — an unchanged one is not sent again.
let archived = "";

/**
 * Keeps the conversation across a reload (persist.ts). Mounted once, by
 * <AskDock /> in the shell. Saved when a question starts, when its answer ends
 * and on CLEAR — not per streamed token: a reload in the middle of an answer
 * brings back the question, marked as cut off.
 */
export function useAskPersistence() {
  const store = useStore();
  const client = useQueryClient();
  const busy = useAtomValue(askBusyAtom);
  const count = useAtomValue(askMessageCountAtom);
  const temporary = useAtomValue(askTemporaryAtom);
  const loaded = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `busy`, `count` and `temporary` are the change signals
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      // Only into an empty conversation: one already under way in this page wins.
      const saved = loadConversation();
      if (saved.messages.length && store.get(askMessagesAtom).length === 0) {
        store.set(askSessionIdAtom, saved.id);
        store.set(askMessagesAtom, saved.messages);
      }
      return;
    }
    const id = store.get(askSessionIdAtom);
    const messages = store.get(askMessagesAtom);
    // An empty conversation is not a reason to forget the stored one: only NEW
    // is (clear() below). A dev rebuild re-creates the atoms empty, and saving
    // that would wipe what the next reload should bring back.
    if (!messages.length) return;
    // A temporary chat is written nowhere: not to this tab's storage, not to a file.
    if (temporary) return;
    saveConversation(messages, id);

    // …and, once an answer has ended, to the conversation's file (sessions.ts):
    // that is what HISTORY lists, here and on the other machine.
    if (busy || !id || !messages.length) return;
    const signature = sessionSignature(id, messages);
    if (signature === archived) return;
    archived = signature;
    void archiveSession(id, messages, store.get(currentViewAtom)).then((error) => {
      store.set(askArchiveNoteAtom, error);
      if (error) archived = ""; // not written: try again after the next answer
      void client.invalidateQueries({ queryKey: ["ask-sessions"] });
    });
  }, [busy, count, temporary, store, client]);
}
