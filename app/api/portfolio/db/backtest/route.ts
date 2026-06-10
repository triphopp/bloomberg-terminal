import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const benchmark = searchParams.get("benchmark") ?? "SPY";
  try {
    const res = await fetch(
      `${PYTHON_API}/api/portfolio/db/backtest?benchmark=${encodeURIComponent(benchmark)}`,
      { cache: "no-store", signal: AbortSignal.timeout(60_000) }  // backtest can be slow
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? "Error" },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[portfolio/db/backtest]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
