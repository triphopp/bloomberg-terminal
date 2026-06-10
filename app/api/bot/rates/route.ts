import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API as BACKEND } from "@/lib/constants";

function fwdParams(searchParams: URLSearchParams) {
  const p = new URLSearchParams();
  ["start_period", "end_period"].forEach((k) => {
    const v = searchParams.get(k);
    if (v) p.set(k, v);
  });
  return p.toString();
}

// GET /api/bot/rates?type=policy|interbank|thb-implied|swap-point
// Default: returns all rates summary
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type");
  const params = fwdParams(searchParams);

  const pathMap: Record<string, string> = {
    policy:      "/api/bot/rates/policy",
    interbank:   "/api/bot/rates/interbank",
    "thb-implied": "/api/bot/rates/thb-implied",
    "swap-point":  "/api/bot/rates/swap-point",
  };

  const backendPath = type && pathMap[type] ? pathMap[type] : "/api/bot/rates";
  const url = `${BACKEND}${backendPath}${params ? "?" + params : ""}`;

  const res = await fetch(url, { next: { revalidate: 3600 } });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
