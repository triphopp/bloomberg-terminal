import { PYTHON_API } from "@/lib/constants";
import { etagJson } from "@/lib/etag";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const qs = req.nextUrl.searchParams.toString();
    const url = `${PYTHON_API}/api/ticker${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend ${res.status}`, detail: text },
        { status: res.status }
      );
    }
    return etagJson(req, await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
