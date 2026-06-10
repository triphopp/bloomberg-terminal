import { PYTHON_API } from "@/lib/constants";

export async function POST(request: Request) {
  const body = await request.json();
  try {
    const pyRes = await fetch(`${PYTHON_API}/api/clippings/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!pyRes.ok || !pyRes.body) {
      return Response.json({ error: `Backend ${pyRes.status}` }, { status: 500 });
    }
    // Proxy the SSE stream directly to the browser
    return new Response(pyRes.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (err) {
    console.error("[clippings/ai]", err);
    return Response.json({ error: "Backend unavailable" }, { status: 503 });
  }
}
