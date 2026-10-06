import { type NextRequest, NextResponse } from "next/server";

import { allowedHosts, backendError, crossSiteReason } from "@/lib/ask-proxy";
import { PYTHON_API } from "@/lib/constants";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const target = (id: string) => `${PYTHON_API}/api/news/ask/sessions/${encodeURIComponent(id)}`;

async function relay(res: Response) {
  const raw = await res.text();
  if (!res.ok) {
    return NextResponse.json({ error: backendError(raw, res.status) }, { status: res.status });
  }
  return new NextResponse(raw, { headers: { "Content-Type": "application/json" } });
}

// GET — one saved conversation, pictures included.
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    return relay(
      await fetch(target(id), { cache: "no-store", signal: AbortSignal.timeout(30_000) })
    );
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// PUT { messages, page?, model? } — save the conversation (the whole of it, after each answer).
export async function PUT(req: NextRequest, { params }: Params) {
  const refusal = crossSiteReason(req.headers, allowedHosts(process.env.DEV_ORIGINS));
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  const { id } = await params;
  try {
    return relay(
      await fetch(target(id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      })
    );
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// PATCH { pinned } — pin a conversation to the top of HISTORY (kept in its file, so both machines see it).
export async function PATCH(req: NextRequest, { params }: Params) {
  const refusal = crossSiteReason(req.headers, allowedHosts(process.env.DEV_ORIGINS));
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
  const { id } = await params;
  try {
    return relay(
      await fetch(target(id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      })
    );
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

// DELETE — out of the list; the backend moves the files to `_deleted`, it erases nothing.
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    return relay(
      await fetch(target(id), { method: "DELETE", signal: AbortSignal.timeout(15_000) })
    );
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
