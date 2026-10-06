import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DIGEST_CHARS,
  HISTORY_CHARS,
  HISTORY_PAIRS,
  historyFor,
  historyIsPrivate,
} from "../history.ts";
import type { AskMessage } from "../types.ts";

const q = (content: string, extra: Partial<AskMessage> = {}): AskMessage => ({
  role: "user",
  content,
  ...extra,
});
const a = (content: string, extra: Partial<AskMessage> = {}): AskMessage => ({
  role: "assistant",
  content,
  ...extra,
});

test("finished exchanges go back, in order", () => {
  assert.deepEqual(historyFor([q("q1"), a("a1"), q("q2"), a("a2")]), [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
  ]);
});

test("a stopped or failed question is left out with its answer", () => {
  const messages = [
    q("q1"),
    a("a1"),
    q("stopped"),
    a("half an ans", { error: "หยุดแล้ว" }),
    q("failed"),
    a("", { error: "HTTP 503" }),
    q("empty"),
    a("   "),
    q("q5"),
    a("a5"),
  ];
  const roles = historyFor(messages).map((t) => `${t.role}:${t.content}`);
  assert.deepEqual(roles, ["user:q1", "assistant:a1", "user:q5", "assistant:a5"]);
});

test("the answer still streaming is not history", () => {
  assert.deepEqual(historyFor([q("q1"), a("so far", { pending: true })]), []);
});

test("never two turns of one role in a row", () => {
  const messages = [q("a"), q("b"), a("B"), a("stray"), q("c"), a("C")];
  const roles = historyFor(messages).map((t) => t.role);
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1]);
  assert.equal(roles[0], "user");
  assert.equal(roles[roles.length - 1], "assistant");
});

const PIC = "data:image/jpeg;base64,AAAA";

test("the latest question with pictures keeps them for a few exchanges", () => {
  const [turn] = historyFor([q("what is this", { images: [PIC] }), a("a chart")]);
  assert.deepEqual(turn, { role: "user", content: "what is this", images: [PIC] });

  // Two exchanges later it is still within reach…
  const near = historyFor([
    q("what is this", { images: [PIC] }),
    a("a chart"),
    q("q2"),
    a("a2"),
    q("q3"),
    a("a3"),
  ]);
  assert.deepEqual(near[0].images, [PIC]);
  // …three later it is only mentioned.
  const far = historyFor([
    q("what is this", { images: [PIC] }),
    a("a chart"),
    q("q2"),
    a("a2"),
    q("q3"),
    a("a3"),
    q("q4"),
    a("a4"),
  ]);
  assert.equal(far[0].images, undefined);
  assert.match(far[0].content, /^what is this\n\[1 picture/);
  assert.ok(!JSON.stringify(far).includes("base64"));
});

test("only one set of pictures travels: the newest", () => {
  const h = historyFor([
    q("first", { images: [PIC, PIC] }),
    a("a"),
    q("second", { images: [PIC] }),
    a("b"),
  ]);
  assert.match(h[0].content, /\[2 picture/);
  assert.equal(h[0].images, undefined);
  assert.deepEqual(h[2], { role: "user", content: "second", images: [PIC] });
});

test("pictures a reload could not keep are still mentioned", () => {
  const [turn] = historyFor([q("what is this", { lostImages: 2 }), a("a chart")]);
  assert.match(turn.content, /\[2 picture/);
  assert.equal(turn.images, undefined);
});

test("a long answer is cut", () => {
  const [, answer] = historyFor([q("q"), a("x".repeat(HISTORY_CHARS + 500))]);
  assert.ok(answer.content.length < HISTORY_CHARS + 60);
  assert.ok(answer.content.endsWith("cut here]"));
});

test("private follows the answers that are kept", () => {
  assert.equal(historyIsPrivate([q("q"), a("a", { private: true })]), true);
  assert.equal(historyIsPrivate([q("q"), a("a")]), false);
  // An answer that is not going back takes its private data with it.
  assert.equal(historyIsPrivate([q("q"), a("half", { private: true, error: "หยุดแล้ว" })]), false);
});

test("a question carries when it was asked", () => {
  const [question, answer] = historyFor([q("q1", { at: 1_791_278_000_000 }), a("a1")]);
  assert.equal(question.at, 1_791_278_000_000);
  assert.equal(answer.at, undefined);
  assert.equal("at" in historyFor([q("q"), a("a")])[0], false);
});

test("answers before the last HISTORY_PAIRS go back short, the recent ones in full", () => {
  const messages: AskMessage[] = [];
  for (let n = 0; n < HISTORY_PAIRS + 2; n++) messages.push(q(`q${n}`), a("w".repeat(5_000)));
  const turns = historyFor(messages);
  assert.equal(turns.length, (HISTORY_PAIRS + 2) * 2);
  assert.ok(turns[1].content.length < DIGEST_CHARS + 50);
  assert.ok(turns[3].content.endsWith("cut here]"));
  assert.equal(turns[5].content.length, 5_000);
});
