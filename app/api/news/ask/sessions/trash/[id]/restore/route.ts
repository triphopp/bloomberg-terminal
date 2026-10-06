import { type NextRequest, NextResponse } from "next/server";

import { backendError } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST — put a deleted conversation back in the list.
export async function POST(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const res = await fetch(
      `${PYTHON_API}/api/news/ask/sessions/trash/${encodeURIComponent(id)}/restore`,
      { method: "POST", signal: AbortSignal.timeout(15_000) }
    );
    const raw = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
    }
    return new NextResponse(raw, { headers: { "Content-Type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
