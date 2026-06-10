import { NextRequest, NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${PYTHON_API}/api/options/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `Backend ${res.status}` }));
      return NextResponse.json(err, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
