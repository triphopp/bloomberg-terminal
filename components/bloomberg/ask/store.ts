import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type { AskChoice, AskMessage, AskPageContext } from "./types";

/**
 * ASK state — one conversation for the whole terminal. Everything a surface
 * needs is an atom here, so the drawer, a docked column and a question bar are
 * views of the same thing however many of them are mounted, and a new page
 * gets ASK without holding any state of its own.
 */

/** Every ASK request goes through this proxy (app/api/news/ask → routers/news_ai.py). */
export const ASK_API = "/api/news/ask";

// Not persisted: an answer is a reading of "now" and goes stale by itself.
export const askMessagesAtom = atom<AskMessage[]>([]);
/** How many messages — what persistence watches instead of every streamed token. */
export const askMessageCountAtom = atom((get) => get(askMessagesAtom).length);
/** Pictures waiting to go with the next question — one tray, whichever box is on screen. */
export const askDraftImagesAtom = atom<string[]>([]);
/**
 * The file this conversation is saved to (sessions.ts) — set with its first
 * question, null again after NEW. Null also for a conversation not started.
 */
export const askSessionIdAtom = atom<string | null>(null);
/** ASK → HISTORY is open. */
export const askHistoryOpenAtom = atom(false);
/** Why the last save to the conversation file failed; null when it did not. */
export const askArchiveNoteAtom = atom<string | null>(null);
/** What is typed and not sent yet — kept when the box moves, hides or the view changes. */
export const askDraftTextAtom = atom("");
/** A question is being answered (the header icon shows it too). */
export const askBusyAtom = atom(false);

/** Provider + model picked in MODEL ▸ (localStorage). The API key is never here. */
export const askChoiceAtom = atomWithStorage<AskChoice>(
  "bloomberg_news_ask_model",
  { provider: null, model: null },
  undefined,
  { getOnInit: true }
);
export const askSettingsOpenAtom = atom(false);

/** Bumped to hand the caret to whichever question box is on screen. */
export const askFocusSignalAtom = atom(0);

// ── Where the conversation is shown ──────────────────────────────────────────
// A view that has room gives the conversation a column of its own (<AskColumn>,
// which registers here while mounted). Every other view gets the drawer from
// <AskDock> in the shell. The two keep separate open flags: hiding the column
// on one view must not decide whether a drawer covers the next one.

/** Mounted <AskColumn>s. Above zero, the view on screen hosts the conversation. */
export const askHostCountAtom = atom(0);
export const askHostedAtom = atom((get) => get(askHostCountAtom) > 0);

const dockOpenAtom = atom(true);
const drawerOpenAtom = atom(false);

/** Open flag of the surface in use on this view. */
export const askOpenAtom = atom(
  (get) => (get(askHostedAtom) ? get(dockOpenAtom) : get(drawerOpenAtom)),
  (get, set, open: boolean) => set(get(askHostedAtom) ? dockOpenAtom : drawerOpenAtom, open)
);

/** The hosted column is on screen — it appears with the first question. */
export const askColumnShownAtom = atom(
  (get) => get(askHostedAtom) && get(dockOpenAtom) && get(askMessagesAtom).length > 0
);
/** The drawer is on screen (it is, before the first question too). */
export const askDrawerShownAtom = atom((get) => !get(askHostedAtom) && get(drawerOpenAtom));

/**
 * Header icon / `c`. On a hosting view the conversation is on the page already,
 * so its box gets the caret; anywhere else the drawer opens or closes.
 */
export const toggleAskAtom = atom(null, (get, set) => {
  if (get(askHostedAtom)) {
    set(dockOpenAtom, true);
    set(askFocusSignalAtom, (n) => n + 1);
  } else {
    set(drawerOpenAtom, (v) => !v);
  }
});

/** What the page on screen says about itself — set with useAskContext(). */
export const askPageContextAtom = atom<AskPageContext | null>(null);
