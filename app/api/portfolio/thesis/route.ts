import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol") ?? "";
  if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  try {
    const res = await fetch(`${PYTHON_API}/api/portfolio/thesis/${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? "Not found" },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[portfolio/thesis]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
