import assert from "node:assert/strict";
import test from "node:test";
import { clusterStories, sameStory, storyWords } from "../story-clusters.ts";

const T = "2026-10-22T";
const art = (title: string, symbols: string[], at: string, company = "", sentiment = "NEU") => ({
  title,
  symbols,
  company,
  published_at: `${T}${at}:00Z`,
  sentiment: sentiment as "POS" | "NEG" | "NEU",
});

test("company names and tickers are not story words; moves and days fold", () => {
  const w = storyWords(
    art("Why AMD Stock Fell on Thursday", ["AMD"], "20:00", "Advanced Micro Devices")
  );
  assert.deepEqual([...w].sort(), ["@2026-10-22", "↓"]);
});

test("the same template about two companies is one story", () => {
  const stories = clusterStories([
    art(
      "Microsoft (MSFT) Falls More Steeply Than Broader Market: What Investors Need to Know",
      ["MSFT"],
      "04:00",
      "Microsoft Corporation",
      "NEG"
    ),
    art(
      "Micron (MU) Falls More Steeply Than Broader Market: What Investors Need to Know",
      ["MU"],
      "04:05",
      "Micron Technology",
      "NEG"
    ),
    art(
      "Why Does SanDisk Stock's High Cash Yield Get So Little Credit?",
      ["SNDK"],
      "03:00",
      "Sandisk"
    ),
  ]);
  assert.equal(stories.length, 2);
  assert.deepEqual(stories[0].symbols.sort(), ["MSFT", "MU"]);
  assert.equal(stories[0].neg, 2);
  assert.equal(stories[1].items.length, 1);
});

test("why-it-fell stories of one day join, whatever the verb", () => {
  const stories = clusterStories([
    art("Why AMD Stock Fell on Thursday", ["AMD"], "20:00", "Advanced Micro Devices"),
    art("Why Intel Stock Fell Today", ["INTC"], "21:00", "Intel Corporation"),
    art("Why Micron Stock Dropped on Thursday", ["MU"], "19:00", "Micron Technology"),
    art(
      "3 big reasons Micron and other chip stocks fell hard on Thursday",
      ["MU"],
      "18:00",
      "Micron Technology"
    ),
  ]);
  assert.equal(stories.length, 1);
  assert.equal(stories[0].items.length, 4);
});

test("different stories stay apart", () => {
  const stories = clusterStories([
    art(
      "Broadcom (AVGO) Stock Could Be A Bargain Following Its 5.7x Run",
      ["AVGO"],
      "08:00",
      "Broadcom Inc."
    ),
    art(
      "Volkswagen workers may get Microsoft AI instead of a raise",
      ["MSFT"],
      "09:00",
      "Microsoft Corporation"
    ),
    art("Intel vs. Qualcomm: A Widening Gap in Revenue", ["INTC"], "05:00", "Intel Corporation"),
  ]);
  assert.equal(stories.length, 3);
});

test("one word in common is not a story", () => {
  assert.equal(sameStory(new Set(["↓", "chip"]), new Set(["↓", "guidance", "cut"])), false);
});

test("a story far apart in time is a new story", () => {
  const stories = clusterStories([
    { ...art("Why AMD Stock Fell", ["AMD"], "20:00"), published_at: "2026-10-22T20:00:00Z" },
    { ...art("Why AMD Stock Fell", ["AMD"], "20:00"), published_at: "2026-10-18T20:00:00Z" },
  ]);
  assert.equal(stories.length, 2);
});

test("the lead is the member closest to the rest", () => {
  const [s] = clusterStories([
    art("Chip stocks slide as Micron warns on wafer supply", ["MU"], "10:00", "Micron"),
    art("Micron warns on wafer supply, chip stocks slide", ["MU"], "10:30", "Micron"),
    art(
      "Chip stocks slide after Micron wafer supply warning hits AMD",
      ["MU", "AMD"],
      "11:00",
      "Micron"
    ),
  ]);
  assert.equal(s.items.length, 3);
  assert.ok(s.items.includes(s.lead));
});

test("quote pages are never a story", () => {
  const stories = clusterStories([
    art(
      "Arm Holdings plc (ARM) Stock Price, News, Quote & History",
      ["ARM"],
      "10:00",
      "Arm Holdings"
    ),
    art("AXT, Inc. (AXTI) Stock Price, News, Quote & History", ["AXTI"], "10:05", "AXT Inc"),
  ]);
  assert.equal(stories.length, 2);
});
