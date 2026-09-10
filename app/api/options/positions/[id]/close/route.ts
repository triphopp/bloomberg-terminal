import { PYTHON_API } from "@/lib/constants";
import { type NextRequest, NextResponse } from "next/server";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The closing price is what turns a closed lot into realized P&L, so the body
  // has to reach the backend. An empty body stays valid (price unknown).
  const body = await req.json().catch(() => ({}));
  try {
    const res = await fetch(`${PYTHON_API}/api/options/positions/${id}/close`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
