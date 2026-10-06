import { NextResponse } from "next/server";

import { backendError } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

// GET /api/news/ask/sessions — saved ASK conversations, newest first, and where
// this machine keeps them (backend/ask_sessions.py).
export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/news/ask/sessions`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
