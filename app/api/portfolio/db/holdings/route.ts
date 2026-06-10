import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/portfolio/db/holdings`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? "Error" },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[portfolio/db/holdings]", err);
    return NextResponse.json({ holdings: [], error: "Backend unavailable" }, { status: 503 });
  }
}
