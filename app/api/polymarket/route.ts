import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// GET /api/polymarket          → /api/polymarket/signals (all 8 types)
// GET /api/polymarket?type=X   → /api/polymarket/signals/{type}
// GET /api/polymarket?q=X      → /api/polymarket/search?q=X
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type");
  const q = searchParams.get("q");

  const mcp = searchParams.get("mcp");

  let path: string;
  if (mcp !== null) {
    path = "/api/polymarket/mcp";
  } else if (q) {
    path = `/api/polymarket/search?q=${encodeURIComponent(q)}`;
  } else if (type) {
    path = `/api/polymarket/signals/${encodeURIComponent(type)}`;
  } else {
    path = "/api/polymarket/signals";
  }

  try {
    const res = await fetch(`${PYTHON_API}${path}`, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend ${res.status}`, detail: text },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

// POST /api/polymarket → force refresh all signals
export async function POST() {
  try {
    const res = await fetch(`${PYTHON_API}/api/polymarket/refresh`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend ${res.status}`, detail: text },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

// DELETE /api/polymarket → clear cache
export async function DELETE() {
  try {
    const res = await fetch(`${PYTHON_API}/api/polymarket/cache`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
