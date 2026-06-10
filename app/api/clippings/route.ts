import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q   = searchParams.get("q")   ?? "";
  const dir = searchParams.get("dir") ?? "";
  try {
    const params = new URLSearchParams();
    if (q)   params.set("q",   q);
    if (dir) params.set("dir", dir);
    const qs  = params.toString();
    const url = `${PYTHON_API}/api/clippings${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[clippings/list]", err);
    return NextResponse.json({ clippings: [], error: "Backend unavailable" }, { status: 503 });
  }
}
