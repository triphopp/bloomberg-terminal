import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const symbol = searchParams.get("symbol") ?? "";
  const period   = searchParams.get("period")   ?? "1y";
  const interval = searchParams.get("interval") ?? "";

  let pythonUrl: string;

  switch (type) {
    case "search":
      pythonUrl = `${PYTHON_API}/api/stock/search?q=${encodeURIComponent(symbol)}`;
      break;
    case "quote":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/quote/${encodeURIComponent(symbol)}`;
      break;
    case "history":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/history/${encodeURIComponent(symbol)}?period=${encodeURIComponent(period)}${interval ? `&interval=${encodeURIComponent(interval)}` : ""}`;
      break;
    case "financials":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/financials/${encodeURIComponent(symbol)}`;
      break;
    case "balance-sheet":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/balance-sheet/${encodeURIComponent(symbol)}`;
      break;
    case "dividends":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/dividends/${encodeURIComponent(symbol)}`;
      break;
    case "analyst":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/analyst/${encodeURIComponent(symbol)}`;
      break;
    case "estimates":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/estimates/${encodeURIComponent(symbol)}`;
      break;
    case "ownership":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/ownership/${encodeURIComponent(symbol)}`;
      break;
    case "earnings-calendar":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/earnings-calendar/${encodeURIComponent(symbol)}`;
      break;
    case "sec-filings":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/sec-filings/${encodeURIComponent(symbol)}`;
      break;
    case "ratios":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/ratios/${encodeURIComponent(symbol)}`;
      break;
    case "management":
      if (!symbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
      pythonUrl = `${PYTHON_API}/api/stock/management/${encodeURIComponent(symbol)}`;
      break;
    default:
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }

  try {
    const res = await fetch(pythonUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[stock/${type}] ${symbol}:`, err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
