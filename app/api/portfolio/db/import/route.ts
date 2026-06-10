import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${PYTHON_API}/api/portfolio/db/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    console.error("[portfolio/db/import]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
