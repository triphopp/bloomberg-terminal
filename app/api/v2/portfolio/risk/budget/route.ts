import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

async function forward(req: Request, method: "GET" | "PUT" | "DELETE", body?: string) {
  try {
    const qs = new URL(req.url).searchParams.toString();
    const r = await fetch(`${API}/api/v2/portfolio/risk/budget${qs ? `?${qs}` : ""}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: AbortSignal.timeout(method === "GET" ? 90_000 : 15_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/portfolio/risk/budget ${method}]`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

export async function GET(req: Request) {
  return forward(req, "GET");
}

export async function PUT(req: Request) {
  return forward(req, "PUT", await req.text());
}

export async function DELETE(req: Request) {
  return forward(req, "DELETE");
}
