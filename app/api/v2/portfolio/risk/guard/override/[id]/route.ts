import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const r = await fetch(
      `${API}/api/v2/portfolio/risk/guard/override/${encodeURIComponent(id)}`,
      { method: "DELETE", signal: AbortSignal.timeout(15_000) }
    );
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/risk/guard/override DELETE]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
