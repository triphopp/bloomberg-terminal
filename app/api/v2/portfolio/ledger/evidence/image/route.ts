import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const response = await fetch(
      `${PYTHON_API}/api/v2/portfolio/ledger/evidence/image${new URL(req.url).search}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!response.ok) {
      return NextResponse.json(await response.json(), { status: response.status });
    }
    return new NextResponse(await response.arrayBuffer(), {
      headers: {
        "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ detail: "Evidence image unavailable" }, { status: 503 });
  }
}
