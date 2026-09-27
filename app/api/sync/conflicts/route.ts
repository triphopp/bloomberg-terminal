import { PYTHON_API as API } from "@/lib/constants";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const all = new URL(req.url).searchParams.get("all") === "1" ? "?all=true" : "";
  try {
    const r = await fetch(`${API}/api/sync/conflicts${all}`, {
      signal: AbortSignal.timeout(20_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (err) {
    console.error("[sync conflicts]", err);
    return NextResponse.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
