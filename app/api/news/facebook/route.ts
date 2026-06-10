import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const pages = searchParams.get("pages") ?? "";
  const limit = searchParams.get("limit") ?? "8";

  if (!pages.trim()) {
    return NextResponse.json({ posts: [], source: "none" });
  }

  try {
    const url = `${PYTHON_API}/api/news/facebook?pages=${encodeURIComponent(pages)}&limit=${encodeURIComponent(limit)}`;
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { posts: [], error: (err as { detail?: string }).detail ?? `Backend error ${res.status}` },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[news/facebook]", err);
    return NextResponse.json({ posts: [], error: "Backend unavailable" }, { status: 503 });
  }
}
