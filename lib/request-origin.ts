/**
 * Did a request come from this app's own page? Pure — no Next import, so it runs
 * under `node --test`. Used by `proxy.ts` for every write to `/api/**`.
 *
 * Why it is needed: the routes under app/api forward a body to the backend as
 * JSON whatever it arrived as, and the backend sees the proxy — this machine —
 * as the caller. A page on any other site open in the same browser may send a
 * form or a `no-cors` fetch with a text/plain body without asking anyone; the
 * route relabels it and the backend books it: a trade, a cash movement, a
 * thesis edit, an API key. The other site cannot read the answer. It does not
 * need to.
 */

export type HeaderSource = { get(name: string): string | null };

export interface Refusal {
  status: number;
  error: string;
}

// A name that only resolves on this machine or this network. A public DNS name
// pointed at 127.0.0.1 (DNS rebinding) has dots and none of these endings.
const LOCAL_NAME_RE = /^(localhost|[^.]+|.+\.(localhost|local|lan|home|internal|home\.arpa))$/i;
const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

function hostName(host: string): string {
  const v6 = /^\[[^\]]+\]/.exec(host);
  return v6 ? v6[0] : host.replace(/:\d+$/, "");
}

/**
 * Extra names the terminal is opened by — `DEV_ORIGINS` in .env.local,
 * comma-separated, the same list next.config.mjs serves dev assets to (a
 * tunnel, a VPN name). Local names and IP addresses need no entry.
 */
export function allowedHosts(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Why a write must not go through — or null when it came from this app's own
 * page (or from a program, which sends none of these headers and is not what
 * this is for).
 *
 * - `Sec-Fetch-Site`: every current browser says where the request started.
 *   Anything but `same-origin` (or `none`, typed by the user) is another site.
 * - `Origin`: sent on every cross-origin write; must be the host that was asked.
 * - the host itself: a local name or an address. A public DNS name is refused
 *   unless listed — it may have been re-pointed at this machine.
 */
export function crossOriginReason(headers: HeaderSource, allowed: string[] = []): Refusal | null {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return { status: 403, error: "request from another site refused" };
  }
  const host = headers.get("host") ?? "";
  const origin = headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { status: 403, error: "request from another site refused" };
    }
    if (originHost.toLowerCase() !== host.toLowerCase()) {
      return { status: 403, error: "request from another site refused" };
    }
  }
  const name = hostName(host).toLowerCase();
  if (name && !IP_RE.test(name) && !LOCAL_NAME_RE.test(name) && !allowed.includes(name)) {
    return {
      status: 403,
      error: `the terminal does not take changes under the name ${name} — open it by its local address, or add the name to DEV_ORIGINS in .env.local`,
    };
  }
  return null;
}
