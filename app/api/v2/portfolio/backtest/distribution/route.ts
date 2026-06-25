import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const qs = searchParams.toString();
  try {
    const res = await fetch(
      `${PYTHON_API}/api/v2/portfolio/backtest/distribution${qs ? `?${qs}` : ""}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend ${res.status}`, detail: text },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
