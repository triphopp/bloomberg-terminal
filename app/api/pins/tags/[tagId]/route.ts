import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ tagId: string }> }
) {
  const { tagId } = await params;
  try {
    const r = await fetch(`${API}/api/pins/tags/${encodeURIComponent(tagId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    const d = await r.json();
    return NextResponse.json(d, { status: r.status });
  } catch (err) {
    console.error("[pins/tags/[tagId] DELETE]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
