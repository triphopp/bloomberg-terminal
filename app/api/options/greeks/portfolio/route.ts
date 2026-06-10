import { NextRequest, NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function GET(req: NextRequest) {
  try {
    const qs = new URL(req.url).searchParams.toString();
    const res = await fetch(`${PYTHON_API}/api/options/greeks/portfolio${qs ? "?" + qs : ""}`, {
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
