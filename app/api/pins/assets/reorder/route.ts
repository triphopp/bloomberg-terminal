import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/pins/assets/reorder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[pins/assets/reorder PATCH]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
