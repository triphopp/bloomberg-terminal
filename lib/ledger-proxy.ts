// Ledger v2 (backend/ledger.py): a PORT write that reaches into a period already
// agreed with the broker is refused (409 LEDGER_PERIOD_CLOSED) unless it carries
// a reason. The browser sends it as X-Ledger-Correction (URL-encoded, see
// lib/ledger-correction.ts); every proxy that forwards a money write passes it on.
export function ledgerHeaders(req: Request): Record<string, string> {
  const v = req.headers.get("x-ledger-correction");
  return v ? { "X-Ledger-Correction": v } : {};
}
