import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const codes = searchParams.get("codes") ?? "";
  const indicator = searchParams.get("indicator") ?? "listed_companies";
  const params = new URLSearchParams({ codes, indicator });
  try {
    const res = await fetch(`${PYTHON_API}/api/sovereign/compare?${params}`, {
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
