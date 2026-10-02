import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

async function forward(method: "PUT" | "DELETE", body?: string) {
  try {
    const r = await fetch(`${API}/api/v2/portfolio/risk/rebalance/rules`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error(`[v2/portfolio/risk/rebalance/rules ${method}]`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

export async function PUT(req: Request) {
  return forward("PUT", await req.text());
}

export async function DELETE() {
  return forward("DELETE");
}
