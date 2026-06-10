import { NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/macro`, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `Backend ${res.status}`, detail: text }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export async function DELETE() {
  try {
    const res = await fetch(`${PYTHON_API}/api/macro/cache`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
