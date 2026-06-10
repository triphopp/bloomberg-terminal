import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/portfolio/theses`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[portfolio/theses]", err);
    return NextResponse.json({ theses: [], error: "Backend unavailable" }, { status: 503 });
  }
}
