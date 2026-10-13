import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// `?account_id=fund:<id>` lists a fund's accounts; none = the personal ones.
export async function GET(req: Request) {
  try {
    const qs = new URL(req.url).searchParams.toString();
    const r = await fetch(`${API}/api/v2/portfolio/accounts${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/accounts GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/v2/portfolio/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/accounts POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
