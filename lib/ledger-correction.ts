// Ledger v2: a PORT write that reaches into a period already agreed with the
// broker comes back 409 LEDGER_PERIOD_CLOSED (backend/ledger.py). Rather than
// teach every form about it, PORT installs this once: it asks for the reason and
// re-sends the same request with X-Ledger-Correction, and the backend books the
// correction today so the agreed balance never moves. Cancel = the 409 stands.
const WRITE = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const SCOPE = [
  "/api/v2/portfolio/",
  "/api/options/fills",
  "/api/options/trades/",
  "/api/v2/ledger/",
];

export function needsCorrection(
  url: string,
  method: string,
  status: number,
  code: unknown
): boolean {
  return (
    status === 409 &&
    WRITE.has(method.toUpperCase()) &&
    SCOPE.some((p) => url.includes(p)) &&
    code === "LEDGER_PERIOD_CLOSED"
  );
}

export function installLedgerCorrectionRetry(
  ask: (detail: string) => string | null = defaultAsk
): void {
  if (typeof window === "undefined") return;
  const w = window as Window & { __ledgerCorrection?: boolean };
  if (w.__ledgerCorrection) return;
  w.__ledgerCorrection = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if (res.status !== 409 || input instanceof Request) return res;
    const url = typeof input === "string" ? input : input.href;
    const method = init?.method ?? "GET";
    let body: { code?: unknown; detail?: unknown } = {};
    try {
      body = await res.clone().json();
    } catch {
      return res;
    }
    if (!needsCorrection(url, method, res.status, body.code)) return res;
    const reason = ask(String(body.detail ?? "This period is closed."))?.trim();
    if (!reason) return res;
    const headers = new Headers(init?.headers);
    headers.set("X-Ledger-Correction", encodeURIComponent(reason));
    return original(input, { ...init, headers });
  };
}

function defaultAsk(detail: string): string | null {
  return window.prompt(
    `${detail}\n\nเหตุผลของการแก้ไข — จะลงเป็นรายการแก้ไขวันนี้ ยอดที่ปิดงวดแล้วไม่เปลี่ยน (เว้นว่าง = ยกเลิก)`
  );
}
