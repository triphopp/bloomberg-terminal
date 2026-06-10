import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;
  try {
    const res = await fetch(
      `${PYTHON_API}/api/sovereign/${code.toUpperCase()}`,
      { signal: AbortSignal.timeout(20_000), cache: "no-store" }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Backend ${res.status}`, detail: text }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
