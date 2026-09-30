import assert from "node:assert/strict";
import test from "node:test";
import { installLedgerCorrectionRetry, needsCorrection } from "../ledger-correction.ts";

test("only a PORT write refused for a closed period asks for a reason", () => {
  assert.equal(
    needsCorrection("/api/v2/portfolio/trades/x", "PATCH", 409, "LEDGER_PERIOD_CLOSED"),
    true
  );
  assert.equal(needsCorrection("/api/options/fills", "post", 409, "LEDGER_PERIOD_CLOSED"), true);
  assert.equal(
    needsCorrection("/api/v2/portfolio/trades", "GET", 409, "LEDGER_PERIOD_CLOSED"),
    false
  );
  assert.equal(needsCorrection("/api/v2/portfolio/trades", "POST", 409, "OTHER_CONFLICT"), false);
  assert.equal(needsCorrection("/api/v2/zettel/x", "POST", 409, "LEDGER_PERIOD_CLOSED"), false);
});

test("retries once with the encoded reason; cancel keeps the 409", async () => {
  const seen: (string | null)[] = [];
  const g = globalThis as unknown as { window: unknown; fetch: typeof fetch };
  g.fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers).get("X-Ledger-Correction");
    seen.push(h);
    return h
      ? new Response("{}", { status: 200 })
      : new Response(JSON.stringify({ code: "LEDGER_PERIOD_CLOSED", detail: "closed" }), {
          status: 409,
        });
  }) as typeof fetch;
  g.window = g;
  let answer: string | null = "ราคาผิด";
  installLedgerCorrectionRetry(() => answer);
  const ok = await g.fetch("/api/v2/portfolio/trades/1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, [null, encodeURIComponent("ราคาผิด")]);
  answer = null;
  const refused = await g.fetch("/api/v2/portfolio/trades/1", { method: "PATCH" });
  assert.equal(refused.status, 409);
});
