import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const r = await fetch(`${API}/api/v2/portfolio/takeover${qs ? `?${qs}` : ""}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json();
  return NextResponse.json(d, { status: r.status });
}
