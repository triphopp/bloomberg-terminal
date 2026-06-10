import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API as BACKEND } from "@/lib/constants";

// GET /api/bot/fx?type=daily|monthly&start_period=...&end_period=...
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") ?? "daily";
  const p = new URLSearchParams();
  ["start_period", "end_period"].forEach((k) => {
    const v = searchParams.get(k);
    if (v) p.set(k, v);
  });

  const backendPath = type === "monthly" ? "/api/bot/fx/monthly" : "/api/bot/fx/daily";
  const url = `${BACKEND}${backendPath}${p.toString() ? "?" + p : ""}`;

  const res = await fetch(url, { next: { revalidate: 3600 } });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
