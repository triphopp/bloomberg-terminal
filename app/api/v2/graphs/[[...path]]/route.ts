import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

// Catch-all like the theses and zettel proxies next door, with one difference:
// `/{slug}/render` answers with a whole HTML document, not JSON. That response
// is passed through untouched — including its Content-Security-Policy, which is
// what keeps a model-written page from reaching anything off-box — instead of
// being parsed as JSON and thrown away.
const PASSTHROUGH = /\/render$/;

async function proxy(req: Request, path: string[] | undefined, method: string) {
  const suffix = path?.length ? `/${path.map(encodeURIComponent).join("/")}` : "";
  const { searchParams } = new URL(req.url);
  const qs = searchParams.toString();
  const url = `${API}/api/v2/graphs${suffix}${qs ? `?${qs}` : ""}`;
  const hasBody = method === "POST" || method === "PATCH" || method === "PUT";
  let body: string | undefined;
  if (hasBody) {
    const text = await req.text();
    body = text || undefined;
  }
  try {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      // A page with a large inline SVG takes longer to move than a JSON row.
      signal: AbortSignal.timeout(60_000),
    });
    if (PASSTHROUGH.test(suffix)) {
      const html = await r.text();
      const headers = new Headers({
        "Content-Type": r.headers.get("content-type") ?? "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      const csp = r.headers.get("content-security-policy");
      if (csp) headers.set("Content-Security-Policy", csp);
      return new Response(html, { status: r.status, headers });
    }
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/graphs ${method} ${suffix}]`, err);
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
