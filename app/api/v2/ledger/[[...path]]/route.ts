import { PYTHON_API as API } from "@/lib/constants";
import { ledgerHeaders } from "@/lib/ledger-proxy";
import { NextResponse } from "next/server";

// Catch-all proxy for the append-only ledger (backend/routers/ledger.py).
// Refusals come back as {code, detail, evidence} with 409/422 — passed through.
async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/ledger${suffix}${qs ? `?${qs}` : ""}`;
  let body: string | undefined;
  if (method !== "GET") {
    const text = await req.text();
    body = text || undefined;
  }
  try {
    const r = await fetch(url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...ledgerHeaders(req) },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json().catch(() => ({ detail: `Backend ${r.status}` }));
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/ledger ${method} ${suffix}]`, err);
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
