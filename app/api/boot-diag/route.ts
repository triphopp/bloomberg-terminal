import { NextResponse } from "next/server";

/**
 * Dev-only sink for the boot watchdog (`app/boot-watchdog.tsx`).
 *
 * When the terminal fails to mount the interesting state — was the document
 * prerendered, which scripts never finished, what the browser was doing — only
 * exists in that tab, and the watchdog reloads the page a moment later, taking
 * the console with it. Beaconing it here puts it in the dev-server output
 * (`logs/frontend.log`), so a stall that happens while nobody is watching is
 * still diagnosable afterwards.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    payload = { parseError: true };
  }

  console.warn("[boot-diag]", JSON.stringify(payload));
  return new NextResponse(null, { status: 204 });
}
