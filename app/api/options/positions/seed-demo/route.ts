import { NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function POST() {
  try {
    const res = await fetch(`${PYTHON_API}/api/options/positions/seed-demo`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
