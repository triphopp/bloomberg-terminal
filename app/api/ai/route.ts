import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ error: "AI not available" }, { status: 503 });
}
