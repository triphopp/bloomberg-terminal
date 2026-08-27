import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// POST /api/listing-gate/screen
export async function POST(req: NextRequest) {
  try {
    const res = await fetch(`${PYTHON_API}/api/listing-gate/screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await req.json()),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[listing-gate/screen]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
