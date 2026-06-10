import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ country: string; sector: string }> },
) {
  const { sector } = await params;
  try {
    const body = await request.json();
    const res = await fetch(
      `${PYTHON_API}/api/sectors/${encodeURIComponent(sector)}/override`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend returned ${res.status}`, detail: text },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
