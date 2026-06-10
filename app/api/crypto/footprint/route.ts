import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol   = searchParams.get("symbol") ?? "BTC";
  const interval = searchParams.get("interval") ?? "5m";
  const limit    = searchParams.get("limit") ?? "20";
  const buckets  = searchParams.get("buckets") ?? "12";

  const pythonUrl = `${PYTHON_API}/api/crypto/footprint/${encodeURIComponent(symbol)}?interval=${interval}&limit=${limit}&buckets=${buckets}`;

  try {
    const res = await fetch(pythonUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[crypto/footprint]:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
