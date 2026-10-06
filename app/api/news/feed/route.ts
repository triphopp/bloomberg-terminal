import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topics = searchParams.get("topics") ?? "market";
  const limit = searchParams.get("limit") ?? "60";
  const fresh = searchParams.get("fresh") === "1" ? "&fresh=1" : "";
  const swr = searchParams.get("swr") === "1" ? "&swr=1" : "";

  try {
    const url = `${PYTHON_API}/api/news/feed?topics=${encodeURIComponent(topics)}&limit=${encodeURIComponent(limit)}${fresh}${swr}`;
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        {
          articles: [],
          error: (err as { detail?: string }).detail ?? `Backend error ${res.status}`,
        },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[news/feed]", err);
    return NextResponse.json({ articles: [], error: "Backend unavailable" }, { status: 503 });
  }
}
