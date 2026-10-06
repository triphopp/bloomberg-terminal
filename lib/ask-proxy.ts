/**
 * What the ASK proxy routes (app/api/news/ask/**) share. Pure — no Next import,
 * so it runs under `node --test`.
 */
import { type HeaderSource, type Refusal, crossOriginReason } from "./request-origin.ts";

export { allowedHosts } from "./request-origin.ts";

/**
 * Why an ASK POST must not be forwarded — or null when it came from this app's
 * own page. `proxy.ts` already holds every write to `/api/**` to
 * `crossOriginReason`; these two routes ask for one thing more, a JSON
 * content type, because what they decide is where every question — the
 * portfolio with it — is sent (the key route), and whether tokens are spent.
 * A browser must preflight a cross-site JSON request, and nothing here answers
 * a preflight, so this holds even if the check in proxy.ts is ever removed.
 */
export function crossSiteReason(headers: HeaderSource, allowed: string[] = []): Refusal | null {
  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) {
    return { status: 415, error: "send JSON (Content-Type: application/json)" };
  }
  return crossOriginReason(headers, allowed);
}

/**
 * The reason inside a backend error body, for the panel. FastAPI answers
 * `{detail: "text"}` or, for a body that failed validation, a list of
 * `{loc, msg}` — "Backend 422" alone tells the user nothing they can act on.
 */
export function backendError(raw: string, status: number): string {
  try {
    const detail = (JSON.parse(raw) as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
    if (Array.isArray(detail) && detail.length) {
      return detail
        .slice(0, 3)
        .map((d: { loc?: unknown[]; msg?: string }) => {
          const where = (d.loc ?? []).filter((p) => p !== "body").join(".");
          return where ? `${where}: ${d.msg ?? "invalid"}` : (d.msg ?? "invalid");
        })
        .join("; ");
    }
  } catch {
    /* not JSON — fall through */
  }
  return `Backend ${status}`;
}
