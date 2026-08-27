import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const r = await fetch(`${API}/api/v2/portfolio/cost-overrides${qs ? `?${qs}` : ""}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json();
  return NextResponse.json(d, { status: r.status });
}

export async function POST(req: Request) {
  const body = await req.json();
  const r = await fetch(`${API}/api/v2/portfolio/cost-overrides`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json();
  return NextResponse.json(d, { status: r.status });
}
