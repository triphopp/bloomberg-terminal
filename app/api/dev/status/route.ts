import { fetchDevStatus } from "@/lib/dev-status";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const { body, status } = await fetchDevStatus();
  return NextResponse.json(body, { status });
}
