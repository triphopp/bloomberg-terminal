import { NextResponse } from "next/server";
import { PYTHON_API as API } from "@/lib/constants";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const r = await fetch(`${API}/api/v2/portfolio/import/excel`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/import/excel POST]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
