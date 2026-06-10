import { NextResponse } from "next/server";
import { PYTHON_API as API } from "@/lib/constants";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const r = await fetch(`${API}/api/v2/portfolio/trades/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/trades PATCH]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const r = await fetch(`${API}/api/v2/portfolio/trades/${id}`, {
      method: "DELETE", signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/trades DELETE]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
