// STORY grouping for the WATCHLIST tab: headlines that tell the same story —
// "Why AMD Stock Fell on Thursday", "Why Intel Stock Fell Today", "Micron (MU)
// Falls More Steeply Than Broader Market" / "Microsoft (MSFT) Falls More Steeply
// Than Broader Market" — become one card, so 47 headlines read as a handful of
// stories. Pure and word-based (no model): tested in __tests__/story-clusters.test.ts.
//
// A title is reduced to the words that carry the story: the company and ticker
// names are dropped (so the same template about two companies matches), moves
// are folded to one word each way ("fell", "drops", "slides" → down), and "today"
// / a weekday become the date the headline was published.

import type { Sentiment } from "./types";

export interface StoryArticle {
  title: string;
  published_at: string;
  symbols: string[];
  company?: string;
  sentiment: Sentiment;
}

export interface Story<T extends StoryArticle> {
  key: string;
  /** The member that shares the most words with the rest — the one to read. */
  lead: T;
  items: T[];
  symbols: string[];
  pos: number;
  neg: number;
  newest: string;
  oldest: string;
}

const STOP = new Set(
  (
    "a an and are as at be but by for from has have how in into is it its of on or that the this to " +
    "was what when where which who why will with after before over under about than vs versus could " +
    "should would can may might just now new here heres there you your we our they their his her " +
    "stock stocks share shares inc corp co ltd plc company companies nasdaq nyse etf"
  ).split(" ")
);

const DOWN =
  /^(fall|falls|fell|falling|drop|drops|dropped|dropping|slide|slides|slid|sliding|tumble|tumbles|tumbled|plunge|plunges|plunged|plummet|plummets|plummeted|sink|sinks|sank|slump|slumps|slumped|decline|declines|declined|lower|loses|lost|down|tank|tanks|tanked|sell|selloff|slips|slipped)$/;
const UP =
  /^(rise|rises|rose|rising|gain|gains|gained|jump|jumps|jumped|surge|surges|surged|soar|soars|soared|rally|rallies|rallied|climb|climbs|climbed|higher|up|advance|advances|advanced|rebound|rebounds|rebounded)$/;
const DAY = /^(today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|yesterday)$/;

// A quote page ("Arm Holdings plc (ARM) Stock Price, News, Quote & History") shares
// its whole title with every other one and says nothing: never part of a story.
const QUOTE_PAGE = /stock price, news, quote|quote & history|price target . prediction/i;

const SIMILAR = 0.5; // Jaccard
const CONTAINED = 0.8; // shared / smaller set, for a short title inside a long one
const MIN_SHARED = 2;
const WINDOW_MS = 36 * 3_600_000; // a story is told within a day and a half

/** The words that carry a headline's story. Exported for the tests. */
export function storyWords(a: StoryArticle): Set<string> {
  const names = new Set<string>();
  for (const s of a.symbols) names.add(s.toLowerCase().replace(/\..*$/, ""));
  for (const w of (a.company ?? "").toLowerCase().split(/[^a-z0-9]+/))
    if (w.length > 2) names.add(w);
  const day = a.published_at.slice(0, 10);
  const out = new Set<string>();
  for (const raw of a.title.toLowerCase().split(/[^a-z0-9%$]+/)) {
    if (!raw || raw.length < 2 || STOP.has(raw) || names.has(raw)) continue;
    if (DOWN.test(raw)) out.add("↓");
    else if (UP.test(raw)) out.add("↑");
    else if (DAY.test(raw)) out.add(`@${day}`);
    else out.add(raw.length > 4 ? raw.replace(/(ies|es|s)$/, "") : raw);
  }
  return out;
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** Same story: enough words in common, by overlap of the whole or of the shorter title. */
export function sameStory(a: Set<string>, b: Set<string>): boolean {
  const s = shared(a, b);
  if (s < MIN_SHARED) return false;
  const union = a.size + b.size - s;
  return s / union >= SIMILAR || s / Math.min(a.size, b.size) >= CONTAINED;
}

/**
 * Group headlines into stories. Single link within a time window: a headline
 * joins the first story (newest first) it shares a story with any member of.
 * Stories come back biggest first, then newest; a story of one is a story too.
 */
export function clusterStories<T extends StoryArticle>(articles: T[]): Story<T>[] {
  const sorted = [...articles].sort((a, b) => b.published_at.localeCompare(a.published_at));
  const words = new Map<T, Set<string>>(sorted.map((a) => [a, storyWords(a)]));
  const groups: T[][] = [];
  for (const a of sorted) {
    const wa = words.get(a) as Set<string>;
    const ta = Date.parse(a.published_at);
    const home = QUOTE_PAGE.test(a.title)
      ? undefined
      : groups.find((g) =>
          g.some((m) => {
            const tm = Date.parse(m.published_at);
            const close =
              !Number.isFinite(ta) || !Number.isFinite(tm) || Math.abs(ta - tm) <= WINDOW_MS;
            return close && !QUOTE_PAGE.test(m.title) && sameStory(wa, words.get(m) as Set<string>);
          })
        );
    if (home) home.push(a);
    else groups.push([a]);
  }

  return groups
    .map((items) => {
      let lead = items[0];
      let best = -1;
      for (const a of items) {
        const wa = words.get(a) as Set<string>;
        const score = items.reduce(
          (n, b) => (b === a ? n : n + shared(wa, words.get(b) as Set<string>)),
          0
        );
        if (score > best) {
          best = score;
          lead = a;
        }
      }
      const symbols = [...new Set(items.flatMap((a) => a.symbols))];
      return {
        key: `${lead.published_at}|${lead.title}`,
        lead,
        items,
        symbols,
        pos: items.filter((a) => a.sentiment === "POS").length,
        neg: items.filter((a) => a.sentiment === "NEG").length,
        newest: items[0].published_at,
        oldest: items[items.length - 1].published_at,
      };
    })
    .sort((a, b) => b.items.length - a.items.length || b.newest.localeCompare(a.newest));
}
