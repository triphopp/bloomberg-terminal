import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const res = await fetch(
      `${PYTHON_API}/api/portfolio/db/transactions/${encodeURIComponent(id)}`,
      { method: "DELETE", signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: (err as { detail?: string }).detail ?? "Error" },
        { status: res.status }
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[portfolio/db/transactions/[id] DELETE]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
