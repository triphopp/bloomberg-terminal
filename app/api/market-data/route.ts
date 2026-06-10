import { marketData as fallbackData } from "@/components/bloomberg/lib/marketData";
import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

// In-memory cache — avoids hammering the Python server on every render
let dataCache: { data: object; ts: number } | null = null;
const CACHE_TTL = 55_000; // 55 s (Python caches for 60 s)

async function fetchFromPython() {
  const res = await fetch(`${PYTHON_API}/api/market-data`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000), // 10 s timeout
  });
  if (!res.ok) throw new Error(`Python API ${res.status}`);
  return res.json();
}

export async function GET() {
  if (dataCache && Date.now() - dataCache.ts < CACHE_TTL) {
    return NextResponse.json(dataCache.data);
  }

  try {
    const data = await fetchFromPython();
    dataCache = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (err) {
    console.error("Python backend unavailable:", err);
    // Graceful fallback — app stays usable without the Python server
    return NextResponse.json({
      ...fallbackData,
      lastUpdated: new Date().toISOString(),
      dataSource: "static",
    });
  }
}

export async function POST() {
  return NextResponse.json({ success: true });
}
