import { NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topics = searchParams.get("topics") ?? "market";
  const limit  = searchParams.get("limit")  ?? "60";

  try {
    const url = `${PYTHON_API}/api/news/feed?topics=${encodeURIComponent(topics)}&limit=${encodeURIComponent(limit)}`;
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { articles: [], error: (err as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[news/feed]", err);
    return NextResponse.json({ articles: [], error: "Backend unavailable" }, { status: 503 });
  }
}
