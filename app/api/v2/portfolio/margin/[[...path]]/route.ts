import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// MARGIN (backend/routers/margin.py): /status, /overview, /settings (GET + PUT).
// Timeout is longer than most proxies: /overview values every margin account
// (positions, option chains, the PORT summary for cash) in one call.
async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/portfolio/margin${suffix}${qs ? `?${qs}` : ""}`;
  const body = method === "PUT" ? (await req.text()) || undefined : undefined;
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/portfolio/margin ${method} ${suffix}]`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "GET");
}
export async function PUT(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "PUT");
}
