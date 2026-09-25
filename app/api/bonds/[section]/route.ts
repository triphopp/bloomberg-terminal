import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

const SECTIONS = new Set(["overview", "supply", "issuance"]);

// GET /api/bonds/overview · /api/bonds/supply · /api/bonds/issuance
export async function GET(_req: Request, { params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!SECTIONS.has(section)) {
    return NextResponse.json({ error: `Unknown section ${section}` }, { status: 404 });
  }

  try {
    // Cold overview fans out to 10 FRED series; supply adds fiscaldata + 4 more.
    const res = await fetch(`${PYTHON_API}/api/bonds/${section}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[bonds]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
