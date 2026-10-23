import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/prebuy-check/<SYM> — MKT → STRUCTURE → CHECK (backend routers/prebuy_check.py).
// Warm ~60 ms; a first look at a symbol waits on ROT / history (a few seconds at most) and
// reports what is still loading in `pending`, which the panel polls.
export async function GET(req: NextRequest, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const qs = req.nextUrl.searchParams.toString();
  const url = `${PYTHON_API}/api/prebuy-check/${encodeURIComponent(symbol)}${qs ? `?${qs}` : ""}`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[prebuy-check]", err);
    return NextResponse.json(
      { status: "error", detail: "CHECK backend unavailable or timed out" },
      { status: 503 }
    );
  }
}
