import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// CAL → Google Calendar (backend/routers/gcal.py). The OAuth callback does not pass
// through here: Google sends the browser straight back to the backend (loopback).
const READS = new Set(["status"]);
const POSTS = new Set(["connect", "sync", "disconnect"]);
const PUTS = new Set(["settings"]);
// A first pass writes one Google call per event.
const TIMEOUT: Record<string, number> = { sync: 180_000 };

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(
  method: "GET" | "POST" | "PUT",
  req: Request,
  { params }: Ctx,
  allowed: Set<string>
) {
  const section = (await params).path.join("/");
  if (!allowed.has(section)) {
    return NextResponse.json({ error: `Unknown section ${section}` }, { status: 404 });
  }
  try {
    const qs = new URL(req.url).search;
    const res = await fetch(`${PYTHON_API}/api/gcal/${section}${qs}`, {
      method,
      cache: "no-store",
      headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: method === "PUT" ? await req.text() : undefined,
      signal: AbortSignal.timeout(TIMEOUT[section] ?? 20_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[gcal]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// GET /api/gcal/status
export const GET = (req: Request, ctx: Ctx) => forward("GET", req, ctx, READS);
// POST /api/gcal/connect · /api/gcal/sync · /api/gcal/disconnect?delete_calendar=
// Same-origin only: proxy.ts.
export const POST = (req: Request, ctx: Ctx) => forward("POST", req, ctx, POSTS);
// PUT /api/gcal/settings {categories, macro_impact}
export const PUT = (req: Request, ctx: Ctx) => forward("PUT", req, ctx, PUTS);
