import { PYTHON_API } from "@/lib/constants";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  try {
    const { path } = await params;
    const subpath = path?.join("/") ?? "";
    const qs = req.nextUrl.searchParams.toString();
    const url = `${PYTHON_API}/api/tail-risk/${subpath}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      // A cold /signals waits behind backend/yahoo_gate.py (6 Yahoo requests at a
      // time, app-wide) and took ~70s on 2026-09-24; at 60s the proxy returned
      // 502 while the backend went on to finish and cache the answer.
      signal: AbortSignal.timeout(180_000),
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
