import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ country: string; sector: string }> },
) {
  const { country, sector } = await params;
  const { searchParams } = new URL(request.url);
  const limit = searchParams.get("limit") ?? "30";
  const index = searchParams.get("index") ?? "";

  try {
    const qs = new URLSearchParams({ limit });
    if (index) qs.set("index", index);

    const res = await fetch(
      `${PYTHON_API}/api/sectors/${encodeURIComponent(country)}/${encodeURIComponent(sector)}?${qs.toString()}`,
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
