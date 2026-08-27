import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/stock/quality/MU
export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    const res = await fetch(`${PYTHON_API}/api/stock/quality/${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[stock/quality]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
