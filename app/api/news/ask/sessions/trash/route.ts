import { NextResponse } from "next/server";

import { backendError } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

// GET /api/news/ask/sessions/trash — deleted conversations, most recently deleted first.
export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/news/ask/sessions/trash`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
    }
    return new NextResponse(raw, { headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
