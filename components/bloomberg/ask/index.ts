/**
 * ASK — the terminal's chat with the model, in one place.
 *
 * Nothing to do for a new view: <AskDock /> in the shell gives every view the
 * drawer (header icon / `c`), and the model is told which view is open.
 *
 * A view may opt into more, one line each:
 *   useAskContext({ symbols, note })  what the page is showing, sent with each question
 *   <AskBar /> + <AskColumn />        the conversation as a column of the view instead
 *                                     of the drawer; useAskColumnShown() to make room
 *
 * State is in store.ts, the request in useAskConversation.ts, the surfaces in
 * ask-panel.tsx. Change ASK there — never copy any of it into a view.
 */
export { AskBar, AskColumn, AskDock, useAskColumnShown, useAskContext } from "./ask-panel";
export { askBusyAtom, askDrawerShownAtom, askOpenAtom, toggleAskAtom } from "./store";
export type { AskPageContext } from "./types";
