import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/news/rotation/members?market=US&group=XLE&top=10&headlines=3&wait=4
export async function GET(req: NextRequest) {
  const qs = new URLSearchParams();
  for (const key of ["market", "group", "top", "headlines", "wait", "fresh"]) {
    const v = req.nextUrl.searchParams.get(key);
    if (v) qs.set(key, v);
  }
  try {
    const res = await fetch(`${PYTHON_API}/api/news/rotation/members?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error("[news/rotation/members]", err);
    return NextResponse.json({ members: [], error: "Backend unavailable" }, { status: 503 });
  }
}
