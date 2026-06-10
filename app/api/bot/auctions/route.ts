import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API as BACKEND } from "@/lib/constants";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const params = new URLSearchParams();
  if (searchParams.get("start_period")) params.set("start_period", searchParams.get("start_period")!);
  if (searchParams.get("end_period"))   params.set("end_period",   searchParams.get("end_period")!);
  if (searchParams.get("raw"))          params.set("raw",           searchParams.get("raw")!);

  const res = await fetch(`${BACKEND}/api/bot/auctions?${params}`, {
    next: { revalidate: 3600 },
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function DELETE() {
  const res = await fetch(`${BACKEND}/api/bot/cache`, { method: "DELETE" });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
