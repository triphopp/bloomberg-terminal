import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

const SECTIONS = new Set(["snapshot", "history", "basis", "factor", "portfolio", "status"]);

// GET /api/cot/snapshot?window= · /api/cot/history?code=&weeks= · /api/cot/basis · /api/cot/factor · /api/cot/portfolio · /api/cot/status
export async function GET(req: Request, { params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!SECTIONS.has(section)) {
    return NextResponse.json({ error: `Unknown section ${section}` }, { status: 404 });
  }

  try {
    // Answered from SQLite; the CFTC pull runs on a backend thread, never in-request.
    const qs = new URL(req.url).search;
    const res = await fetch(`${PYTHON_API}/api/cot/${section}${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[cot]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
