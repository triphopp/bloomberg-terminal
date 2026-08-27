import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

const ALLOWED = new Set(["margin", "check", "market"]);

// GET /api/circuit-breaker/margin
//     /api/circuit-breaker/check?symbol=MU&price=1&prior_close=2
//     /api/circuit-breaker/market?index_value=1&prior_close=2[&time=HH:MM]
export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const [resource] = path ?? [];

  if (!resource || !ALLOWED.has(resource)) {
    return NextResponse.json({ error: "Unknown circuit-breaker resource" }, { status: 404 });
  }

  const qs = req.nextUrl.searchParams.toString();
  try {
    const res = await fetch(`${PYTHON_API}/api/circuit-breaker/${resource}${qs ? `?${qs}` : ""}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[circuit-breaker]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
