import { NextResponse } from "next/server";

import { PYTHON_API as API } from "@/lib/constants";

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
