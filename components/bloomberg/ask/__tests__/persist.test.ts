import assert from "node:assert/strict";
import { test } from "node:test";
import { CUT_BY_RELOAD, forStorage, restore } from "../persist.ts";
import type { AskMessage } from "../types.ts";

test("a stored conversation comes back as it was", () => {
  const saved: AskMessage[] = [
    { role: "user", content: "q", at: 1_700_000_000_000 },
    { role: "assistant", content: "a", private: true, tools: [{ label: "THESIS", detail: "MU" }] },
  ];
  assert.deepEqual(restore(JSON.parse(JSON.stringify(saved))), saved);
});

test("an answer that was streaming when the page went away is marked, not left spinning", () => {
  const out = restore([
    { role: "user", content: "q" },
    { role: "assistant", content: "half", pending: true, status: "READING" },
  ]);
  assert.equal(out[1].pending, false);
  assert.equal(out[1].status, null);
  assert.equal(out[1].error, CUT_BY_RELOAD);
  assert.equal(out[1].content, "half");
});

test("a question saved before its answer slot gets one", () => {
  const out = restore([{ role: "user", content: "q" }]);
  assert.deepEqual(out[1], { role: "assistant", content: "", error: CUT_BY_RELOAD });
});

test("anything that is not a message is dropped", () => {
  assert.deepEqual(restore("nope"), []);
  assert.deepEqual(restore(null), []);
  const out = restore([
    null,
    3,
    { role: "system", content: "x" },
    { role: "user" },
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ]);
  assert.deepEqual(
    out.map((m) => m.content),
    ["q", "a"]
  );
});

test("without room for pictures the question keeps their count", () => {
  const messages: AskMessage[] = [
    {
      role: "user",
      content: "q",
      images: ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"],
    },
    { role: "assistant", content: "a" },
  ];
  assert.equal(forStorage(messages, true), messages);
  const slim = forStorage(messages, false);
  assert.deepEqual(slim[0], { role: "user", content: "q", lostImages: 2 });
  assert.equal(slim[1], messages[1]);
});
