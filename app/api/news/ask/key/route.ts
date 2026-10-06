import { type NextRequest, NextResponse } from "next/server";

import { allowedHosts, crossSiteReason } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

// POST /api/news/ask/key { provider, api_key?, base_url? } — write-only: the key
// goes to backend/.env and is never sent back or logged here. Only this app's
// own page may call it: whoever sets the key or the address decides where every
// later question is sent.
export async function POST(req: NextRequest) {
  const refusal = crossSiteReason(req.headers, allowedHosts(process.env.DEV_ORIGINS));
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  try {
    const res = await fetch(`${PYTHON_API}/api/news/ask/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: (body as { detail?: string }).detail ?? `Backend ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(body);
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
