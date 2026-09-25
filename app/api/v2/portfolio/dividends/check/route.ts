import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Own file: POST /dividends/check would otherwise hit [id]/route.ts (PUT/DELETE
// only) and 405 — Next routes one file per path (gotchas: cash/transfer).
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/v2/portfolio/dividends/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/dividends/check POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
