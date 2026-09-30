import { PYTHON_API } from "@/lib/constants";
import { ledgerHeaders } from "@/lib/ledger-proxy";
import { NextResponse } from "next/server";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await fetch(`${PYTHON_API}/api/options/trades/${id}`, {
      method: "DELETE",
      headers: ledgerHeaders(_req),
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const r = await fetch(`${PYTHON_API}/api/options/trades/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...ledgerHeaders(req) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
