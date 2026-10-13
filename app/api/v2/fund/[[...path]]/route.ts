import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Catch-all proxy for the fund book (backend/routers/fund.py): members,
// deposits and the units they bought. Refusals come back as
// {detail: {code, detail}} with 403/404/409/422 — passed through unchanged.
// Two things are not JSON: a slip upload (multipart, forwarded as it came)
// and a slip image (bytes, returned as they are).
async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/fund${suffix}${qs ? `?${qs}` : ""}`;
  const type = req.headers.get("content-type") ?? "";
  let body: BodyInit | undefined;
  let headers: Record<string, string> = {};
  if (method !== "GET") {
    if (type.startsWith("multipart/form-data")) {
      body = await req.arrayBuffer();
      headers = { "Content-Type": type }; // carries the boundary
    } else {
      const text = await req.text();
      body = text || undefined;
      if (body) headers = { "Content-Type": "application/json" };
    }
  }
  try {
    const r = await fetch(url, {
      method,
      headers,
      body,
      // reading a slip runs OCR, and the first one loads the model
      signal: AbortSignal.timeout(type.startsWith("multipart/") ? 270_000 : 30_000),
    });
    const out = r.headers.get("content-type") ?? "";
    if (r.ok && out.startsWith("image/")) {
      return new NextResponse(await r.arrayBuffer(), {
        status: r.status,
        headers: { "Content-Type": out, "Cache-Control": "private, max-age=3600" },
      });
    }
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
