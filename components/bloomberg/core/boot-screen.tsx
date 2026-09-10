"use client";

import { useEffect, useState } from "react";

/**
 * Loading fallback for the `dynamic(ssr:false)` terminal import in `app/page.tsx`.
 *
 * The terminal chunk occasionally never arrives — a dev-server chunk that fails
 * to compile, a `ChunkLoadError` after a rebuild changed the hashes, a stalled
 * request. `next/dynamic` has no timeout: when its import() promise neither
 * resolves nor rejects the fallback stays on screen forever, which reads as
 * "the terminal is stuck on BLOOMBERG until I hit refresh".
 *
 * So this screen watches itself. Still mounted after RELOAD_AFTER_MS → reload
 * once, which is exactly the refresh the user was doing by hand. If the reload
 * lands on the same stall, stop (no reload loop) and hand over a RETRY button
 * plus the hard-reload hint.
 */

const RELOAD_AFTER_MS = 12_000;
/** A reload older than this is a different visit, not a failed retry. */
const RETRY_WINDOW_MS = 60_000;
const RETRY_KEY = "bloomberg_boot_retry_at";

/** `Document.prerendering` is Chrome-only and not in lib.dom yet. */
const isPrerendering = () =>
  typeof document !== "undefined" &&
  (document as Document & { prerendering?: boolean }).prerendering === true;

function readLastRetry(): number {
  try {
    const raw = sessionStorage.getItem(RETRY_KEY);
    return raw ? Number(raw) : 0;
  } catch {
    return 0;
  }
}

export function BootScreen() {
  // A prerendered document (Chrome starts one while the URL is being typed in
  // the omnibox) is offscreen and may sit here for a long time without being
  // stuck — don't count it and don't reload it away. Arm at activation instead.
  const [armed, setArmed] = useState(() => !isPrerendering());
  const [elapsed, setElapsed] = useState(0);
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (armed) return;
    const onActivate = () => setArmed(true);
    document.addEventListener("prerenderingchange", onActivate, { once: true });
    return () => document.removeEventListener("prerenderingchange", onActivate);
  }, [armed]);

  useEffect(() => {
    if (!armed) return;

    const startedAt = Date.now();
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);

    const reload = () => {
      // Already retried for this stall → don't spin; let the user decide.
      if (Date.now() - readLastRetry() < RETRY_WINDOW_MS) {
        setStalled(true);
        return;
      }
      try {
        sessionStorage.setItem(RETRY_KEY, String(Date.now()));
      } catch {
        /* private mode — one retry without the guard is still better than a hang */
      }
      window.location.reload();
    };

    const watchdog = setTimeout(reload, RELOAD_AFTER_MS);

    // A chunk that errors out is a hang we can act on immediately.
    const onError = (e: ErrorEvent) => {
      const name = (e.error as Error | undefined)?.name;
      if (
        name === "ChunkLoadError" ||
        /Loading chunk|dynamically imported module/i.test(e.message)
      ) {
        reload();
      }
    };
    window.addEventListener("error", onError);

    return () => {
      clearInterval(tick);
      clearTimeout(watchdog);
      window.removeEventListener("error", onError);
    };
  }, [armed]);

  return (
    <div
      className="flex flex-col items-center justify-center h-screen gap-3"
      style={{ background: "#000" }}
    >
      <span className="text-sm font-bold font-mono tracking-[0.3em]" style={{ color: "#ff9900" }}>
        BLOOMBERG
      </span>

      {stalled ? (
        <div className="flex flex-col items-center gap-2 font-mono text-[10px]">
          <span style={{ color: "#FF4444" }}>TERMINAL CHUNK DID NOT LOAD</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-3 py-1 font-bold"
            style={{ color: "#ff9900", border: "1px solid #ff9900", background: "transparent" }}
          >
            RETRY
          </button>
          <span style={{ color: "#666" }}>
            still stuck → hard reload (Ctrl+Shift+R), then check the dev-server output
          </span>
        </div>
      ) : (
        elapsed >= 3 && (
          <span className="font-mono text-[10px]" style={{ color: "#666" }}>
            loading terminal… {elapsed}s{elapsed >= 8 && " — retrying shortly"}
          </span>
        )
      )}
    </div>
  );
}
