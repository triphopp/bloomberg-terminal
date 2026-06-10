import { NextRequest, NextResponse } from "next/server";
import { PYTHON_API } from "@/lib/constants";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const qs = searchParams.toString();
    const res = await fetch(`${PYTHON_API}/api/regime/correlation${qs ? `?${qs}` : ""}`, {
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Backend ${res.status}`, detail: text },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
