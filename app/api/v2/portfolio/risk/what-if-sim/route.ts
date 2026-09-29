import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const r = await fetch(`${API}/api/v2/portfolio/risk/what-if-sim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/risk/what-if-sim POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
