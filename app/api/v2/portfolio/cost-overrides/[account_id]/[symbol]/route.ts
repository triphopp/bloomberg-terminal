import { NextResponse } from "next/server";
const API = process.env.PYTHON_API ?? "http://localhost:8000";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ account_id: string; symbol: string }> }
) {
  const { account_id, symbol } = await params;
  const r = await fetch(`${API}/api/v2/portfolio/cost-overrides/${account_id}/${symbol}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  });
  const d = await r.json();
  return NextResponse.json(d, { status: r.status });
}
