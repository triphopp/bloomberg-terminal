import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/clippings/ai/models`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return NextResponse.json({ models: [], error: `Backend ${res.status}` });
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ models: [], error: "Ollama unavailable" });
  }
}
