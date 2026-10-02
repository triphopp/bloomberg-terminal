import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const qs = new URL(req.url).searchParams.toString();
    const r = await fetch(`${API}/api/v2/portfolio/risk/monte-carlo${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(90_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/risk/monte-carlo GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
