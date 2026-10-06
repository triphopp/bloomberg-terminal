import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

// GET /api/news/ask/models?provider=deepseek[&fresh=1] — model ids the saved key may use
export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  const fresh = req.nextUrl.searchParams.get("fresh") === "1" ? "&fresh=1" : "";
  try {
    const res = await fetch(
      `${PYTHON_API}/api/news/ask/models?provider=${encodeURIComponent(provider)}${fresh}`,
      { cache: "no-store", signal: AbortSignal.timeout(25_000) }
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { models: [], error: (body as { detail?: string }).detail ?? `Backend ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(body);
  } catch (err) {
    console.error("[news/ask/models]", err);
    return NextResponse.json({ models: [], error: "Backend unavailable" }, { status: 503 });
  }
}
