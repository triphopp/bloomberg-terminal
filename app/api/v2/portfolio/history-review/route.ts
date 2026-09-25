import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const response = await fetch(
      `${PYTHON_API}/api/v2/portfolio/history-review${new URL(req.url).search}`,
      { cache: "no-store", signal: AbortSignal.timeout(30_000) }
    );
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "Portfolio history review unavailable" }, { status: 503 });
  }
}
