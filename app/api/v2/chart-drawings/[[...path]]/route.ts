import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Catch-all proxy for chart drawings (trend lines, REG channels) —
// backend/routers/chart_drawings.py.
async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/chart-drawings${suffix}${qs ? `?${qs}` : ""}`;
  const body = method === "POST" || method === "PUT" ? (await req.text()) || undefined : undefined;
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/chart-drawings ${method} ${suffix}]`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "GET");
}
export async function POST(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "POST");
}
export async function PUT(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "PUT");
}
export async function DELETE(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "DELETE");
}
