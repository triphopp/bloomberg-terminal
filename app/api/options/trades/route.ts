import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const r = await fetch(`${PYTHON_API}/api/options/trades${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(20_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
