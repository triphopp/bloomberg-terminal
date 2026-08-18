import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

/**
 * Record today's ATM IV for a symbol.
 *
 * The SD heatmap can only plot IV it has on file, and the provider publishes no
 * IV history to back-fill from — so the pane triggers this the first time it is
 * opened on a symbol nobody has recorded yet.
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol");
  const targetDte = searchParams.get("targetDte");

  if (!symbol) {
    return NextResponse.json({ error: "symbol is required" }, { status: 400 });
  }

  try {
    const url = new URL(
      `${PYTHON_API}/api/options/${encodeURIComponent(symbol.toUpperCase())}/iv-snapshot`
    );
    if (targetDte) url.searchParams.set("targetDte", targetDte);

    const res = await fetch(url.toString(), {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });

    const body = await res.json().catch(() => ({}));
    // 404 (no options on this symbol) and 422 (no usable ATM quote) are real
    // answers, not proxy failures — pass the status through so the caller can
    // tell "will never work" from "try again".
    if (!res.ok) {
      return NextResponse.json(
        { error: body?.detail ?? `Backend ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
