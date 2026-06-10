import { NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_API}/api/macro/global-yields`, {
      cache: "no-store",
      signal: AbortSignal.timeout(35_000),
    });
    if (!res.ok) return NextResponse.json({ error: `Backend ${res.status}` }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch (err) {
    console.error("[macro/global-yields]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}

export async function DELETE() {
  try {
    const res = await fetch(`${PYTHON_API}/api/macro/global-yields`, {
      method: "DELETE",
      cache: "no-store",
    });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
