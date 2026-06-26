import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const r = await fetch(`${API}/api/sync/status`, { signal: AbortSignal.timeout(20_000) });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[sync status]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
