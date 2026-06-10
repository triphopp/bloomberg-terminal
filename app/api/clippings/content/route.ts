import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const file = searchParams.get("file") ?? "";
  const dir  = searchParams.get("dir")  ?? "";
  if (!file) return NextResponse.json({ error: "Missing file" }, { status: 400 });
  try {
    const params = new URLSearchParams({ file });
    if (dir) params.set("dir", dir);
    const res = await fetch(
      `${PYTHON_API}/api/clippings/content?${params.toString()}`,
      { cache: "no-store", signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? "Not found" },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[clippings/content]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
