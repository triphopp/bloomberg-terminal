import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  try {
    const url = `${PYTHON_API}/api/options/${encodeURIComponent(symbol.toUpperCase())}/surface`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000), // surface is slower (multiple fetches)
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
