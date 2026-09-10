import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const r = await fetch(`${PYTHON_API}/api/options/trades/${id}/audit-log`, {
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
