import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const r = await fetch(`${PYTHON_API}/api/v2/portfolio/slip/warm`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
