import { NextResponse } from "next/server";
import { PYTHON_API as API } from "@/lib/constants";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const qs = searchParams.toString();
    const r = await fetch(
      `${API}/api/v2/portfolio/risk/history/export${qs ? "?" + qs : ""}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const body = await r.text();
    const contentType = r.headers.get("content-type") ?? "text/csv";
    const disposition = r.headers.get("content-disposition") ?? "";
    return new NextResponse(body, {
      status: r.status,
      headers: {
        "Content-Type": contentType,
        ...(disposition ? { "Content-Disposition": disposition } : {}),
      },
    });
  } catch (err) {
    console.error("[v2/portfolio/risk/history/export GET]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
