import { type NextRequest, NextResponse } from "next/server";

import { allowedHosts, backendError, crossSiteReason } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

const CONFIG = `${PYTHON_API}/api/news/ask/sessions/config`;

// GET — where this machine keeps ASK conversations, and the choices it has.
export async function GET() {
  try {
    const res = await fetch(CONFIG, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// POST { store? , dir? } — set it (backend/.env). Decides where conversations —
// and the private data in them — are written, so it is held to the same rule as
// the API key: this app's own page, JSON only.
export async function POST(req: NextRequest) {
  const refusal = crossSiteReason(req.headers, allowedHosts(process.env.DEV_ORIGINS));
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  try {
    const res = await fetch(CONFIG, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
    }
    return new NextResponse(raw, { headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
