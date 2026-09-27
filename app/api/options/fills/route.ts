import { PYTHON_API } from "@/lib/constants";
import { type NextRequest, NextResponse } from "next/server";

// One option fill from PORT → ENTRY (backend option_fills.py). `dry_run: true`
// previews the lot matches and realized P&L without writing.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${PYTHON_API}/api/options/fills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({ detail: `Backend ${res.status}` }));
    return NextResponse.json(data, { status: res.status });
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 502 });
  }
}
