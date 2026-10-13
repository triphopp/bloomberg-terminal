import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Catch-all proxy for the fund book (backend/routers/fund.py): members,
// deposits and the units they bought. Refusals come back as
// {detail: {code, detail}} with 403/404/409/422 — passed through unchanged.
async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/fund${suffix}${qs ? `?${qs}` : ""}`;
  let body: string | undefined;
  if (method !== "GET") {
    const text = await req.text();
    body = text || undefined;
  }
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json().catch(() => ({ detail: `Backend ${r.status}` }));
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/fund ${method} ${suffix}]`, err);
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
