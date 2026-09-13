import { PYTHON_API } from "@/lib/constants";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const res = await fetch(`${PYTHON_API}/api/options/smile-fit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    const payload = await res.json();
    if (!res.ok)
      return NextResponse.json(
        { error: typeof payload.detail === "string" ? payload.detail : "Invalid SVI fit request" },
        { status: res.status }
      );
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 502 });
  }
}
