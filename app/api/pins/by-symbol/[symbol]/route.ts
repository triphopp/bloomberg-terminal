import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function PUT(req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/pins/by-symbol/${encodeURIComponent(symbol)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[pins/by-symbol PUT]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
