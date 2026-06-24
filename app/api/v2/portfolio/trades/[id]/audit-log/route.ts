import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const r = await fetch(`${API}/api/v2/portfolio/trades/${id}/audit-log`, {
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/trades audit-log GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
