import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const r = await fetch(`${API}/api/sync/push`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[sync push]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
