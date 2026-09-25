import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/** Count one search → symbol open (MKT left panel FREQ tab). Fire-and-forget. */
export async function POST(req: Request) {
  try {
    const res = await fetch(`${PYTHON_API}/api/search-stats/hit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      signal: AbortSignal.timeout(5_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "backend unavailable" }, { status: 200 });
  }
}
