import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const r = await fetch(`${API}/api/dev/restart`, {
      method: "POST",
      headers: { "X-BT-Dev": "1" },
      signal: AbortSignal.timeout(5_000),
    });
    const d = await r.json().catch(() => ({}));
    return NextResponse.json(d, { status: r.status });
  } catch {
    return NextResponse.json({ detail: "Backend unavailable" }, { status: 503 });
  }
}
