import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/v2/portfolio/cash/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Reconcile recomputes the summary (option chains included) server-side.
      signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/cash/reconcile POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
