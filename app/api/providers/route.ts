import { NextResponse } from "next/server";
import { PYTHON_API as API } from "@/lib/constants";

export async function GET() {
  try {
    const r = await fetch(`${API}/api/providers`, { signal: AbortSignal.timeout(20_000) });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[providers GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
