import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API as BACKEND } from "@/lib/constants";

// GET /api/bot/statistics?type=categories|series|search|observations
//   &category=FM_RT_013
//   &keyword=THOR
//   &series_code=FMRTTHORD00003&start_period=2024-01-01&end_period=2024-12-31
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const type = searchParams.get("type") ?? "categories";
  const category = searchParams.get("category") ?? "";
  const keyword = searchParams.get("keyword") ?? "";
  const seriesCode = searchParams.get("series_code") ?? "";
  const startPeriod = searchParams.get("start_period") ?? "";
  const endPeriod = searchParams.get("end_period") ?? "";

  const pathMap: Record<string, string> = {
    categories:    "/api/bot/statistics/categories",
    series:        "/api/bot/statistics/series",
    search:        "/api/bot/statistics/search",
    observations:  "/api/bot/statistics/observations",
  };

  const backendPath = pathMap[type] ?? pathMap["categories"];
  const params = new URLSearchParams();
  if (category)     params.set("category", category);
  if (keyword)      params.set("keyword", keyword);
  if (seriesCode)   params.set("series_code", seriesCode);
  if (startPeriod)  params.set("start_period", startPeriod);
  if (endPeriod)    params.set("end_period", endPeriod);

  const qs = params.toString();
  const url = `${BACKEND}${backendPath}${qs ? "?" + qs : ""}`;

  const res = await fetch(url, { next: { revalidate: 3600 } });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function DELETE() {
  const res = await fetch(`${BACKEND}/api/bot/cache`, { method: "DELETE" });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
