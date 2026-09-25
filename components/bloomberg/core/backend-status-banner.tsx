"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dev-only strip that says when the backend is NOT the code on disk.
 *
 * A backend started without --reload keeps the modules it imported at start;
 * an edited router is then simply absent, and the result (404, a field dropped
 * by an old model) is indistinguishable from a coding bug. This names the
 * cause: "running old code — these files changed", or "down — read the log".
 * Silent when everything is current. Source: GET /api/dev/status.
 */

type Changed = { file: string; change: string; at: string };
type DevStatus = {
  state: "ok" | "stale" | "down";
  pid?: number;
  started_at?: string;
  reload?: boolean;
  legacy?: boolean;
  changed?: Changed[];
  changed_count?: number;
  restart?: "reload" | "launcher" | null;
};

const POLL_MS = 15_000;
const FAST_POLL_MS = 2_000;
// One failed poll is usually a restart in progress; two in a row is an outage.
const DOWN_AFTER = 2;

export function BackendStatusBanner() {
  const [status, setStatus] = useState<DevStatus | null>(null);
  const [downCount, setDownCount] = useState(0);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef<string | undefined>(undefined);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/dev/status", { cache: "no-store" });
      const d: DevStatus = await r.json();
      if (d.state === "down") {
        setDownCount((n) => n + 1);
        return;
      }
      setDownCount(0);
      setStatus(d);
      // A new process (different start time) that is current = restart done.
      if (restarting && d.started_at && d.started_at !== restarting && d.state === "ok") {
        setRestarting(null);
      }
      startedRef.current = d.started_at;
    } catch {
      setDownCount((n) => n + 1);
    }
  }, [restarting]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, restarting ? FAST_POLL_MS : POLL_MS);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [poll, restarting]);

  // Give up waiting after a minute — the banner then shows whatever is true.
  useEffect(() => {
    if (!restarting) return;
    const t = setTimeout(() => setRestarting(null), 60_000);
    return () => clearTimeout(t);
  }, [restarting]);

  const restart = async () => {
    setError(null);
    try {
      const r = await fetch("/api/dev/restart", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(typeof d?.detail === "string" ? d.detail : `restart failed (${r.status})`);
        return;
      }
      setRestarting(startedRef.current ?? "pending");
    } catch {
      setError("restart request failed");
    }
  };

  const down = downCount >= DOWN_AFTER;
  if (restarting) {
    return (
      <Strip color="#60a5fa">BACKEND RESTARTING… the page will work again in a few seconds</Strip>
    );
  }
  if (down) {
    return (
      <Strip color="#f87171">
        BACKEND DOWN — not answering on /api. If you just edited Python, it likely failed to import:
        see <b>logs\backend.log</b> (a code error, not a stale server).
      </Strip>
    );
  }
  if (!status || status.state !== "stale") return null;

  const files = status.changed ?? [];
  const more = (status.changed_count ?? files.length) - Math.min(files.length, 3);
  return (
    <Strip color="#facc15">
      BACKEND RUNNING OLD CODE —{" "}
      {status.legacy ? (
        <>started before this check existed; use the tray menu → Restart servers once</>
      ) : (
        <>
          {files
            .slice(0, 3)
            .map((f) => f.file)
            .join(", ")}
          {more > 0 ? ` +${more} more` : ""} changed after it started ({fmtTime(status.started_at)}
          ). New routes/fields are NOT live yet.
        </>
      )}
      {status.restart && (
        <button
          type="button"
          onClick={restart}
          className="ml-3 font-bold underline hover:opacity-80"
          style={{ color: "#facc15" }}
        >
          RESTART BACKEND
        </button>
      )}
      {!status.restart && !status.legacy && (
        <span className="ml-2 opacity-80">(started by hand — restart it in its terminal)</span>
      )}
      {error && <span className="ml-3 text-[#f87171]">{error}</span>}
    </Strip>
  );
}

function Strip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <output
      className="block shrink-0 px-3 py-1 text-[10px] font-mono border-b"
      style={{ color, borderColor: `${color}55`, background: `${color}14` }}
    >
      {children}
    </output>
  );
}

function fmtTime(iso?: string) {
  if (!iso) return "?";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
