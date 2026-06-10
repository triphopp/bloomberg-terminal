import { NextResponse } from "next/server";
import { PYTHON_API as API } from "@/lib/constants";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const r = await fetch(`${API}/api/v2/portfolio/trades${qs ? "?" + qs : ""}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/trades GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/v2/portfolio/trades`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/trades POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
