import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const r = await fetch(`${PYTHON_API}/api/v2/portfolio/slip/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch {
    return NextResponse.json({ ocr_loaded: false }, { status: 503 });
  }
}
