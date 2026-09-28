import { PYTHON_API as API } from "@/lib/constants";

/**
 * Backend liveness + "is it running the code on disk", for the dev banner.
 * Shared by `/api/dev/status` and `/api/heartbeat`.
 *
 * Three answers the banner needs to tell apart:
 *   up + current code  → backend's own status
 *   up + OLD code      → a backend started before /api/dev existed answers 404
 *   not answering      → down (crashed on import, or still starting)
 */
export async function fetchDevStatus(): Promise<{ body: Record<string, unknown>; status: number }> {
  try {
    const r = await fetch(`${API}/api/dev/status`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (r.status === 404) {
      return {
        body: {
          state: "stale",
          stale: true,
          legacy: true,
          changed: [],
          changed_count: 0,
          restart: null,
        },
        status: 200,
      };
    }
    const d = await r.json();
    return { body: { state: d.stale ? "stale" : "ok", ...d }, status: r.status };
  } catch {
    return { body: { state: "down" }, status: 200 };
  }
}
