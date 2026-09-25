import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const response = await fetch(`${PYTHON_API}/api/v2/portfolio/ledger/check-opening`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await req.json()),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "Opening balance check unavailable" }, { status: 503 });
  }
}
