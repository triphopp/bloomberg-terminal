import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const etf   = searchParams.get("etf") ?? "XLK";
  const limit = searchParams.get("limit") ?? "10";

  try {
    const params = new URLSearchParams({ etf, limit });
    const res = await fetch(
      `${PYTHON_API}/api/heatmap/sector-detail?${params.toString()}`,
      { signal: AbortSignal.timeout(30_000) },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend returned ${res.status}`, detail: text },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
