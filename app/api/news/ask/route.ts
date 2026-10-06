import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { allowedHosts, backendError, crossSiteReason } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

// GET /api/news/ask — is ASK usable (key set, SDK installed, model, tools)
//   ?provider=&model= — the status of that choice instead of the default one
export async function GET(req: NextRequest) {
  try {
    const qs = new URLSearchParams();
    for (const key of ["provider", "model"]) {
      const v = req.nextUrl.searchParams.get(key);
      if (v) qs.set(key, v);
    }
    const res = await fetch(`${PYTHON_API}/api/news/ask/status?${qs.toString()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok)
      return NextResponse.json({ error: `Backend ${res.status}` }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[news/ask]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// POST /api/news/ask { question, history, symbols, … } → SSE, passed through unbuffered.
// From this app's own page only — a question reads the portfolio and spends tokens.
export async function POST(req: NextRequest) {
  const refusal = crossSiteReason(req.headers, allowedHosts(process.env.DEV_ORIGINS));
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  try {
    const res = await fetch(`${PYTHON_API}/api/news/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await req.text(),
      cache: "no-store",
      // Closing the panel or pressing STOP ends the model call too.
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      const raw = await res.text().catch(() => "");
      return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
    }
    return new Response(res.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("[news/ask]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
