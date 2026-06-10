import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function GET() {
  try {
    const r = await fetch(`${API}/api/pins/groups`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[pins/groups GET]", err);
    return NextResponse.json({ groups: [], error: "Backend unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${API}/api/pins/groups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[pins/groups POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
