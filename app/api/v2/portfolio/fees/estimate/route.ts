import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const response = await fetch(
      `${PYTHON_API}/api/v2/portfolio/fees/estimate${new URL(req.url).search}`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) }
    );
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "Fee estimate unavailable" }, { status: 503 });
  }
}
