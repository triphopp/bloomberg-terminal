import { PYTHON_API } from "@/lib/constants";
import { NextResponse } from "next/server";

// A slip takes ~1.5 s on rapidocr (~15 s on the easyocr fallback) once the model is loaded.
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const r = await fetch(`${PYTHON_API}/api/v2/portfolio/slip/read`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(180_000),
    });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (err) {
    console.error("[v2/portfolio/slip/read POST]", err);
    return NextResponse.json({ detail: "Slip reader unavailable" }, { status: 503 });
  }
}
