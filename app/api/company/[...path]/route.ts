import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

const ALLOWED = new Set(["outlook", "filings", "xbrl"]);

// GET /api/company/outlook/MU · /api/company/filings/MU · /api/company/xbrl/MU?period=annual
export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const [resource, symbol] = path ?? [];

  if (!resource || !ALLOWED.has(resource) || !symbol) {
    return NextResponse.json({ error: "Unknown company resource" }, { status: 404 });
  }

  const qs = req.nextUrl.searchParams.toString();
  const url = `${PYTHON_API}/api/company/${resource}/${encodeURIComponent(symbol)}${
    qs ? `?${qs}` : ""
  }`;

  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[company]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
