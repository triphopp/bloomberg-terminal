import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Run one auto-dividend pass now (backend/dividend_auto.py). Same-origin only via proxy.ts.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const r = await fetch(`${API}/api/v2/portfolio/dividends/auto/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/dividends/auto/run POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
