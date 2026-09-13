import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/market-state/<SYM>              — the dashboard payload (~1s cold)
//     /api/market-state/<SYM>/validation   — walk-forward refit (tens of fits)
const SYMBOL_RESOURCES = new Set(["validation"]);

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const segments = path ?? [];

  if (segments.length === 0) {
    return NextResponse.json({ status: "error", detail: "Missing symbol" }, { status: 404 });
  }
  const [, tail] = segments;
  if (tail && !SYMBOL_RESOURCES.has(tail)) {
    return NextResponse.json(
      { status: "error", detail: `Unknown resource ${tail}` },
      { status: 404 }
    );
  }

  const qs = req.nextUrl.searchParams.toString();
  const suffix = segments.map(encodeURIComponent).join("/");
  const url = `${PYTHON_API}/api/market-state/${suffix}${qs ? `?${qs}` : ""}`;

  try {
    // The validation endpoint refits the model dozens of times; the dashboard
    // one fits it once. Both are bounded server-side, but giving up before the
    // backend does would leave the panel blank with nothing to explain it.
    const timeout = tail === "validation" ? 180_000 : 60_000;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[market-state]", err);
    return NextResponse.json(
      { status: "error", detail: "Market State backend unavailable or timed out" },
      { status: 503 }
    );
  }
}
