import { NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function DELETE() {
  try {
    const res = await fetch(`${PYTHON_API}/api/options/positions/demo/clear`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Backend ${res.status}`);
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
