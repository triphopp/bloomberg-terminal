import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/rotation/screen?market=US&group=XLE&top=15
export async function GET(req: NextRequest) {
  const qs = new URLSearchParams();
  for (const key of ["market", "group", "top"]) {
    const v = req.nextUrl.searchParams.get(key);
    if (v) qs.set(key, v);
  }
  try {
    const res = await fetch(`${PYTHON_API}/api/rotation/screen?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error("[rotation/screen]", err);
    return NextResponse.json({ rows: [], error: "Backend unavailable" }, { status: 503 });
  }
}
