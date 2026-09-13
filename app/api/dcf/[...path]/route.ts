import { type NextRequest, NextResponse } from "next/server";

import { PYTHON_API } from "@/lib/constants";

function target(req: NextRequest, path: string[]) {
  const suffix = path.map(encodeURIComponent).join("/");
  const qs = req.nextUrl.searchParams.toString();
  return `${PYTHON_API}/api/dcf/${suffix}${qs ? `?${qs}` : ""}`;
}

async function forward(
  req: NextRequest,
  params: Promise<{ path: string[] }>,
  method: "GET" | "POST" | "DELETE"
) {
  const { path } = await params;
  if (!path?.length || path.length > 2 || (path.length === 2 && path[0] !== "cache")) {
    return NextResponse.json({ detail: "Unknown DCF resource" }, { status: 404 });
  }

  try {
    const init: RequestInit = {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(90_000),
      headers: { "Content-Type": "application/json" },
    };
    if (method === "POST") init.body = await req.text();
    const res = await fetch(target(req, path), init);
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    console.error("[dcf]", error);
    return NextResponse.json(
      { status: "error", detail: "DCF backend unavailable or timed out" },
      { status: 503 }
    );
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, params, "GET");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(req, params, "POST");
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  return forward(req, params, "DELETE");
}
