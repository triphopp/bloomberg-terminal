import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const params = new URLSearchParams();
    const accountId = url.searchParams.get("account_id");
    if (accountId) params.set("account_id", accountId);
    const response = await fetch(`${PYTHON_API}/api/v2/portfolio/ledger/statements?${params}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "Broker statements unavailable" }, { status: 503 });
  }
}

export async function POST(req: Request) {
  try {
    const response = await fetch(`${PYTHON_API}/api/v2/portfolio/ledger/statements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await req.json()),
      signal: AbortSignal.timeout(30_000),
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ detail: "Broker statement could not be saved" }, { status: 503 });
  }
}
