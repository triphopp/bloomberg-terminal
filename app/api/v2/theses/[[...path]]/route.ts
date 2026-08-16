import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// One catch-all instead of a file per verb: the thesis API is a plain CRUD
// surface (/, /{id}, /{id}/events, /{id}/links/{trade_id}, /import-md, …) and
// every route would be the same six lines of pass-through.
async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/theses${suffix}${qs ? `?${qs}` : ""}`;
  const hasBody = method === "POST" || method === "PATCH" || method === "PUT";
  let body: string | undefined;
  if (hasBody) {
    // Some POSTs (import-md, export-md, restore) carry no body at all.
    const text = await req.text();
    body = text || undefined;
  }
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/theses ${method} ${suffix}]`, err);
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
export async function PATCH(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "PATCH");
}
export async function DELETE(req: Request, { params }: Ctx) {
  return proxy(req, (await params).path, "DELETE");
}
