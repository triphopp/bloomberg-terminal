import assert from "node:assert/strict";
import { test } from "node:test";
import { displayMathAt, splitMath } from "../math.ts";

const math = (text: string) =>
  splitMath(text).flatMap((s) => (s.kind === "math" ? [`${s.display ? "D" : "I"}:${s.tex}`] : []));

test("inline formulas between dollar signs", () => {
  const text =
    "ตัวอย่าง $d_t = d_{t-1}(1+r_t)/(1+g_t) - pb_t$ โดย $r_t = r_{t-1} + K(y_t - r_{t-1})$, $K = 0.11$, $r_0 = 3.20$";
  assert.deepEqual(math(text), [
    "I:d_t = d_{t-1}(1+r_t)/(1+g_t) - pb_t",
    "I:r_t = r_{t-1} + K(y_t - r_{t-1})",
    "I:K = 0.11",
    "I:r_0 = 3.20",
  ]);
  assert.equal(splitMath(text)[0].kind, "text");
});

test("a lone letter is a variable", () => {
  assert.deepEqual(math("ถ้า $K$ เป็น 0.11 และ $g$ คงที่"), ["I:K", "I:g"]);
  assert.deepEqual(math("US$5 และ C$7"), []);
});

test("dollar amounts are not formulas", () => {
  for (const text of [
    "ราคา $5 ถึง $10 ต่อหุ้น",
    "range $1,200-$1,300",
    "AAPL $254.10 and MSFT $512.44",
    "costs $5 = cheap, or $6",
  ]) {
    assert.deepEqual(math(text), [], text);
  }
});

test("display and bracket forms", () => {
  assert.deepEqual(math("so $$E = mc^2$$ holds"), ["D:E = mc^2"]);
  assert.deepEqual(math("so \\[a^2 + b^2\\] and \\(x_1\\)"), ["D:a^2 + b^2", "I:x_1"]);
});

test("a formula still being streamed stays text", () => {
  assert.deepEqual(math("ได้ว่า $d_t = d_{t-1}"), []);
});

test("display block on its own lines", () => {
  assert.deepEqual(displayMathAt(["$$", "d_t = \\frac{a}{b}", "$$", "after"], 0), {
    tex: "d_t = \\frac{a}{b}",
    end: 2,
  });
  assert.deepEqual(displayMathAt(["$$x^2$$"], 0), { tex: "x^2", end: 0 });
  assert.deepEqual(displayMathAt(["\\[", "x^2", "\\]"], 0), { tex: "x^2", end: 2 });
});

test("not a display block", () => {
  assert.equal(displayMathAt(["plain line"], 0), null);
  assert.equal(displayMathAt(["$$", "x^2"], 0), null); // closing fence not here yet
  assert.equal(displayMathAt(["$$x$$ is the answer"], 0), null); // inline, opens a sentence
});
