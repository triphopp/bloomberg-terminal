import { type NextRequest, NextResponse } from "next/server";

import { allowedHosts, crossOriginReason } from "@/lib/request-origin";

/**
 * Every write to `/api/**` must come from this app's own page.
 *
 * The route handlers forward what they are sent to the backend, which sees
 * this machine as the caller — so without this, any web page open in the same
 * browser could post a trade, a cash movement or an API key here with a plain
 * form (lib/request-origin.ts has the detail). Reads are left alone: another
 * site cannot see their answer, and there are hundreds a minute.
 *
 * One place instead of a check in each of ~60 route files, so a new route is
 * covered without anyone remembering to.
 */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(req: NextRequest) {
  if (READS.has(req.method)) return NextResponse.next();
  const refusal = crossOriginReason(req.headers, allowedHosts(process.env.DEV_ORIGINS));
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
