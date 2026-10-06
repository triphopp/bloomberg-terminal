import type { bloombergColors } from "../lib/theme-config";

export type ThemeColors = typeof bloombergColors.dark;

// ── ASK (/api/news/ask — a model with live data tools, SSE) ────────────────────

/** One model provider ASK can call. The key itself never leaves the backend. */
export interface AskProvider {
  id: string;
  label: string;
  /** Name of the backend/.env variable that holds the key. */
  key_env: string;
  has_key: boolean;
  base_url: string;
  /** `custom` only: the address is the user's to set. */
  needs_url: boolean;
  /** Key (and address) in place — a model can be called. */
  configured: boolean;
  /** Short list to pick from before the live list is fetched. */
  models: string[];
  default_model: string;
}

/** Which model answers. Kept in localStorage; null = the backend's default. */
export interface AskChoice {
  provider: string | null;
  model: string | null;
}

export interface AskStatus {
  /** The chosen provider has its key and a model is selected. */
  configured: boolean;
  provider: string;
  provider_id: string;
  default_provider: string;
  model: string;
  providers: AskProvider[];
  web_search: boolean;
  /** General web search engine in use (needs its own key); null = news search + page reading only. */
  search_provider: string | null;
  tools: string[];
}

export interface AskSource {
  url: string;
  title: string;
}

export interface AskToolCall {
  label: string;
  detail: string;
}

export interface AskMessage {
  role: "user" | "assistant";
  content: string;
  /** User only — pictures sent with this question (JPEG data URLs). */
  images?: string[];
  /** User only — the question had this many pictures; a reload could not keep them. */
  lostImages?: number;
  /** User only — when it was asked (ms). An answer is a reading of that moment. */
  at?: number;
  /** Assistant only — still streaming. */
  pending?: boolean;
  /** What the model is doing before the first token (THINKING / READING). */
  status?: string | null;
  tools?: AskToolCall[];
  sources?: AskSource[];
  error?: string;
  model?: string;
  /** Assistant only — the answer was written from private data (portfolio, thesis, note). */
  private?: boolean;
}

export type AskEvent =
  | { type: "status"; text: string }
  | { type: "token"; text: string }
  /** Text so far was a preamble before a tool call — drop it. */
  | { type: "reset" }
  | { type: "tool"; name: string; label: string; detail: string }
  | { type: "sources"; sources: AskSource[] }
  | { type: "error"; text: string }
  | {
      type: "done";
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      private?: boolean;
    };

/**
 * What the page on screen tells the model about itself (useAskContext). Sent
 * with every question, so "this stock" / "this tab" mean something.
 */
export interface AskPageContext {
  /** Tickers the page is about — listed ahead of the watchlist. */
  symbols?: string[];
  /** One or two plain sentences: what the user is looking at. */
  note?: string;
}
