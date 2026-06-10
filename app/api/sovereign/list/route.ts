import { NextResponse, NextRequest } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(req: NextRequest) {
  try {
    const q   = req.nextUrl.searchParams.get("q") ?? "";
    const url = `${PYTHON_API}/api/sovereign/list${q ? `?q=${encodeURIComponent(q)}` : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Backend ${res.status}`, detail: text }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
