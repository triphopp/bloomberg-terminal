import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// Segments that are resources rather than tickers. Everything else in the first
// position is treated as a symbol, which is what /api/ir-stress/<SYM>/... needs.
const ROOT_RESOURCES = new Set(["curve", "scenarios", "screen"]);
const SYMBOL_RESOURCES = new Set(["exposure", "duration", "scenario"]);

// GET /api/ir-stress/curve
//     /api/ir-stress/scenarios
//     /api/ir-stress/screen/rank?symbols=A,B&scenario=par_+100
//     /api/ir-stress/AMT
//     /api/ir-stress/AMT/exposure · /duration · /scenario?id=par_+100
export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const segments = path ?? [];

  if (segments.length === 0) {
    return NextResponse.json({ error: "Missing resource" }, { status: 404 });
  }

  const [head, tail] = segments;
  const isRoot = ROOT_RESOURCES.has(head);
  if (!isRoot && tail && !SYMBOL_RESOURCES.has(tail)) {
    return NextResponse.json({ error: `Unknown resource ${tail}` }, { status: 404 });
  }

  const qs = req.nextUrl.searchParams.toString();
  const suffix = segments.map(encodeURIComponent).join("/");
  const url = `${PYTHON_API}/api/ir-stress/${suffix}${qs ? `?${qs}` : ""}`;

  try {
    // A cold call fans out to EDGAR, FRED and five years of prices — measured at
    // over a minute for a name nobody has looked at yet, and the whole panel goes
    // blank if this gives up first. The backend caches for six hours after that.
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(150_000) });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[ir-stress]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
