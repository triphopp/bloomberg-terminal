import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/** Forget one symbol from the FREQ list. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    const res = await fetch(`${PYTHON_API}/api/search-stats/${encodeURIComponent(symbol)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "backend unavailable" }, { status: 502 });
  }
}
