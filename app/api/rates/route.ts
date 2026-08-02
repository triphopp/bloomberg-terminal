import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/rates/curve`, {
      cache: "no-store",
      // Cold cache fans out 11 FRED calls plus a 1.2 MB MOF download
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[rates/curve]:", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
