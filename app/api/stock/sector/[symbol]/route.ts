import { NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  try {
    const res = await fetch(`${PYTHON_API}/api/stock/sector/${encodeURIComponent(symbol)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ symbol, sector: null, industry: null });
  }
}
