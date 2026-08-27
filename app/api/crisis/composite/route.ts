import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/crisis/composite
export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/crisis/composite`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[crisis/composite]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
