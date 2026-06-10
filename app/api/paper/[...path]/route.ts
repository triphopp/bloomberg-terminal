import { NextRequest, NextResponse } from "next/server";

import { PYTHON_API as BACKEND } from "@/lib/constants";

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;
  const path = segments.join("/");
  const qs = req.nextUrl.searchParams.toString();
  const url = `${BACKEND}/api/paper/${path}${qs ? `?${qs}` : ""}`;

  const init: RequestInit = { method: req.method, headers: {} };

  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      const body = await req.text();
      if (body) {
        init.body = body;
        (init.headers as Record<string, string>)["Content-Type"] =
          req.headers.get("content-type") || "application/json";
      }
    } catch {
      // no body
    }
  }

  try {
    const res = await fetch(url, init);
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: "Backend unreachable", detail: String(err) },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
export const PUT = proxy;
export const PATCH = proxy;
