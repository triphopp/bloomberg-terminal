import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await fetch(`${API}/api/sync/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      signal: AbortSignal.timeout(30_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (err) {
    console.error("[sync resolve]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
