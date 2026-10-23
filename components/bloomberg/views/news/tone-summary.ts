// News tone of one symbol for MKT → STRUCTURE → CHECK: how many headlines in the
// last 72 h read positive / negative / neutral, the last 24 h beside it, and the
// latest few. Context only — the tone is headline_tone.py's word list, so CHECK
// shows it and never counts it as a conflict. Pure (__tests__/tone-summary.test.ts).

import type { Sentiment } from "./types";

export interface ToneArticle {
  title: string;
  url?: string;
  source?: string;
  published_at: string;
  sentiment: Sentiment;
  symbols?: string[];
}

export interface ToneCount {
  n: number;
  pos: number;
  neg: number;
  neu: number;
}

export interface ToneSummary {
  last72h: ToneCount;
  last24h: ToneCount;
  /** Newest first, inside 72 h. */
  latest: ToneArticle[];
  /** Headlines with no readable date, or older than 72 h. */
  outside: number;
}

const HOUR = 3_600_000;

function count(items: ToneArticle[]): ToneCount {
  const c: ToneCount = { n: items.length, pos: 0, neg: 0, neu: 0 };
  for (const a of items) {
    if (a.sentiment === "POS") c.pos++;
    else if (a.sentiment === "NEG") c.neg++;
    else c.neu++;
  }
  return c;
}

export function summarizeTone(
  articles: ToneArticle[],
  symbol: string,
  now: number,
  latestN = 4
): ToneSummary {
  const sym = symbol.toUpperCase();
  const seen = new Set<string>();
  const inWindow: { a: ToneArticle; t: number }[] = [];
  let outside = 0;
  for (const a of articles) {
    if (a.symbols?.length && !a.symbols.some((s) => s.toUpperCase() === sym)) continue;
    const key = a.url || a.title;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = Date.parse(a.published_at);
    if (!Number.isFinite(t) || now - t > 72 * HOUR || t - now > HOUR) {
      outside++;
      continue;
    }
    inWindow.push({ a, t });
  }
  inWindow.sort((x, y) => y.t - x.t);
  return {
    last72h: count(inWindow.map((x) => x.a)),
    last24h: count(inWindow.filter((x) => now - x.t <= 24 * HOUR).map((x) => x.a)),
    latest: inWindow.slice(0, latestN).map((x) => x.a),
    outside,
  };
}
