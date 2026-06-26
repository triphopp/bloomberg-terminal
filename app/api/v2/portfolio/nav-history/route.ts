import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const r = await fetch(`${API}/api/v2/portfolio/nav-history${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/nav-history GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
