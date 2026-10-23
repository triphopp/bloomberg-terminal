import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/news/rotation?market=US&kind=sector&wait=4&fresh=1
export async function GET(req: NextRequest) {
  const qs = new URLSearchParams();
  for (const key of ["market", "kind", "wait", "fresh"]) {
    const v = req.nextUrl.searchParams.get(key);
    if (v) qs.set(key, v);
  }
  try {
    const res = await fetch(`${PYTHON_API}/api/news/rotation?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(45_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error("[news/rotation]", err);
    return NextResponse.json({ groups: [], error: "Backend unavailable" }, { status: 503 });
  }
}
