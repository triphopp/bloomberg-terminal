import { NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

/**
 * Proxy for all /api/analytics/* endpoints.
 * Query param `fn` selects the sub-endpoint:
 *   GET /api/analytics?fn=corr&a=AAPL&b=MSFT&period=3m
 *   → Python: GET /api/analytics/corr?a=AAPL&b=MSFT&period=3m
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fn = searchParams.get("fn");
  if (!fn) {
    return NextResponse.json({ error: "Missing query param: fn" }, { status: 400 });
  }

  // Forward all params except fn to the Python sub-endpoint
  const forward = new URLSearchParams(searchParams);
  forward.delete("fn");

  const pythonUrl = `${PYTHON_API}/api/analytics/${encodeURIComponent(fn)}${forward.size ? `?${forward}` : ""}`;

  try {
    const res = await fetch(pythonUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),  // analytics can be slow (yfinance)
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return NextResponse.json(
        { error: (data as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[analytics/${fn}]`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
