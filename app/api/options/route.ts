import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const expiry = searchParams.get("expiry");

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  try {
    const url = new URL(`${PYTHON_API}/api/options/${encodeURIComponent(symbol.toUpperCase())}`);
    if (expiry) url.searchParams.set("expiry", expiry);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
