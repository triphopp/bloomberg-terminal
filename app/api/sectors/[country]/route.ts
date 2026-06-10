import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ country: string }> },
) {
  const { country } = await params;
  try {
    const res = await fetch(
      `${PYTHON_API}/api/sectors/${encodeURIComponent(country)}`,
      { signal: AbortSignal.timeout(10_000) },
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ country: string }> },
) {
  const { country } = await params;
  try {
    const res = await fetch(
      `${PYTHON_API}/api/sectors/${encodeURIComponent(country)}`,
      { method: "DELETE", signal: AbortSignal.timeout(10_000) },
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
