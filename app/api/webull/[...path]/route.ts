import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

const READS = new Set(["status", "depth"]);
const WRITES = new Set(["token", "token/check"]);

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(
  method: "GET" | "POST",
  req: Request,
  { params }: Ctx,
  allowed: Set<string>
) {
  const section = (await params).path.join("/");
  if (!allowed.has(section)) {
    return NextResponse.json({ error: `Unknown section ${section}` }, { status: 404 });
  }
  try {
    const qs = method === "GET" ? new URL(req.url).search : "";
    const res = await fetch(`${PYTHON_API}/api/webull/${section}${qs}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error("[webull]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// GET /api/webull/status · /api/webull/depth?symbol=&depth=&overnight=
export const GET = (req: Request, ctx: Ctx) => forward("GET", req, ctx, READS);

// POST /api/webull/token (asks Webull for an access token — in production that texts
// a code to the account owner) · /api/webull/token/check. Same-origin only: proxy.ts.
export const POST = (req: Request, ctx: Ctx) => forward("POST", req, ctx, WRITES);
