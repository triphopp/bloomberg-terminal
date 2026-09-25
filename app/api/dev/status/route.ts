import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Three answers the banner needs to tell apart:
//   up + current code  → backend's own status
//   up + OLD code      → a backend started before /api/dev existed answers 404
//   not answering      → down (crashed on import, or still starting)
export async function GET() {
  try {
    const r = await fetch(`${API}/api/dev/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (r.status === 404) {
      return NextResponse.json({
        state: "stale",
        stale: true,
        legacy: true,
        changed: [],
        changed_count: 0,
        restart: null,
      });
    }
    const d = await r.json();
    return NextResponse.json({ state: d.stale ? "stale" : "ok", ...d }, { status: r.status });
  } catch {
    return NextResponse.json({ state: "down" }, { status: 200 });
  }
}
