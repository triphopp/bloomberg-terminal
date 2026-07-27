import { PYTHON_API } from "@/lib/constants";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const qs = req.nextUrl.searchParams.toString();
    const url = `${PYTHON_API}/api/watchlist/signals${qs ? `?${qs}` : ""}`;
    // A cold cache means a yfinance batch download for the whole watchlist.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend ${res.status}`, detail: text },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
