import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const r = await fetch(`${API}/api/alerts/notify/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[alerts/notify/test POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
