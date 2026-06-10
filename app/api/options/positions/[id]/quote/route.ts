import { NextRequest, NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await fetch(`${PYTHON_API}/api/options/positions/${id}/quote`, {
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
