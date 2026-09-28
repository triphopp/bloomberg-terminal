import { PYTHON_API as API } from "@/lib/constants";
import { fetchDevStatus } from "@/lib/dev-status";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * One poll for the header's background state — was three browser requests
 * every 15–30s (`/api/dev/status`, `/api/sync/status`, `/api/providers`) — plus
 * the per-table versions of the DB change feed (`/api/changes`).
 * The parts are fetched in parallel over loopback; one failing part is `null`
 * with its error, never a failed heartbeat. `dev` only in `next dev` (the
 * banner that reads it renders nowhere else).
 *
 * Shape: { dev: DevStatus | null, sync: SyncStatus | null, providers: {...} | null,
 *          changes: {table: version} | null, errors: { sync?, providers?, changes? } }
 */
async function part(path: string): Promise<unknown> {
  const r = await fetch(`${API}${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function GET() {
  const dev = process.env.NODE_ENV === "development";
  const [devStatus, sync, providers, changes] = await Promise.allSettled([
    dev ? fetchDevStatus().then((d) => d.body) : Promise.resolve(null),
    part("/api/sync/status"),
    part("/api/providers"),
    part("/api/changes"),
  ]);
  const errors: Record<string, string> = {};
  if (sync.status === "rejected") errors.sync = String(sync.reason?.message ?? sync.reason);
  if (providers.status === "rejected")
    errors.providers = String(providers.reason?.message ?? providers.reason);
  if (changes.status === "rejected")
    errors.changes = String(changes.reason?.message ?? changes.reason);
  return NextResponse.json(
    {
      dev: devStatus.status === "fulfilled" ? devStatus.value : { state: "down" },
      sync: sync.status === "fulfilled" ? sync.value : null,
      providers: providers.status === "fulfilled" ? providers.value : null,
      changes:
        changes.status === "fulfilled"
          ? ((changes.value as { tables?: Record<string, number> }).tables ?? null)
          : null,
      errors,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
