import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const handles = searchParams.get("handles") ?? "{}";
  const limit = searchParams.get("limit") ?? "50";
  const fresh = searchParams.get("fresh") === "1" ? "&fresh=1" : "";
  try {
    const url = `${PYTHON_API}/api/social/feed?handles=${encodeURIComponent(handles)}&limit=${encodeURIComponent(limit)}${fresh}`;
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        {
          posts: [],
          errors: [(err as { detail?: string }).detail ?? `Backend error ${res.status}`],
        },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[news/social]", err);
    return NextResponse.json({ posts: [], errors: ["Backend unavailable"] }, { status: 503 });
  }
}
