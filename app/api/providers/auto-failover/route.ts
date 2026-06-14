import { NextResponse } from "next/server";
import { PYTHON_API as API } from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/providers/auto-failover`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[providers/auto-failover POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
