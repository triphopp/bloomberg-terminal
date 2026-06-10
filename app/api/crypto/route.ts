import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? "overview";
  const coin = searchParams.get("coin") ?? "";
  const period = searchParams.get("period") ?? "1mo";
  const interval = searchParams.get("interval") ?? "";

  let pythonUrl: string;

  switch (type) {
    case "overview":
      pythonUrl = `${PYTHON_API}/api/crypto`;
      break;
    case "history":
      if (!coin) return NextResponse.json({ error: "Missing coin" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/crypto/history/${encodeURIComponent(coin)}?period=${encodeURIComponent(period)}&interval=${encodeURIComponent(interval)}`;
      break;
    default:
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  try {
    const res = await fetch(pythonUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status },
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[crypto/${type}]:`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
