"use client";
import { PinnedAssets } from "@/components/bloomberg/views/pinned-assets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Provider } from "jotai";
// Browser-only fixture: copy to app/watchlist-check/page.tsx temporarily; remove after testing.
// All /api calls are mocked and Storage writes are disabled in this tab. Never deploy the test route.
import { useEffect, useState } from "react";

export default function Check() {
  const [ready, setReady] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [client] = useState(() => new QueryClient());
  useEffect(() => {
    (window as unknown as { __BT_MOUNTED__: boolean }).__BT_MOUNTED__ = true;
    const originalFetch = window.fetch;
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = () => null;
    Storage.prototype.setItem = () => {};
    const assets = Array.from({ length: 1000 }, (_, i) => ({
      id: `p${i}`,
      symbol: `T${String(i).padStart(4, "0")}`,
      group_id: "a",
      priority: 1,
      comment: "",
      added_at: "2026-09-23",
      tags: [],
    }));
    const all = [
      ...assets,
      ...assets.slice(0, 100).map((p) => ({ ...p, id: `dup${p.id}`, group_id: "b" })),
    ];
    window.fetch = async (input, options) => {
      const url = new URL(String(input), location.origin);
      if (!url.pathname.startsWith("/api/")) return originalFetch(input, options);
      setStats((prev) => ({ ...prev, [url.pathname]: (prev[url.pathname] ?? 0) + 1 }));
      if (options?.method && options.method !== "GET") return Response.json({ ok: true });
      if (url.pathname === "/api/pins/groups")
        return Response.json([
          { id: "a", name: "Large list", color: "#f59e0b" },
          { id: "b", name: "Overlap", color: "#22c55e" },
        ]);
      if (url.pathname === "/api/pins/assets") return Response.json(all);
      if (url.pathname === "/api/pins/tags") return Response.json([]);
      const syms = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      const statuses = Object.fromEntries(syms.map((s) => [s, { status: "ready" }]));
      await new Promise((r) => setTimeout(r, 10));
      if (url.pathname.endsWith("/quotes"))
        return Response.json({
          statuses,
          quotes: Object.fromEntries(
            syms.map((s) => [
              s,
              {
                symbol: s,
                regularMarketPrice: Number(s.slice(1)) + 100,
                regularMarketChange: 1,
                regularMarketChangePercent: Number(s.slice(1)) / 10,
              },
            ])
          ),
        });
      if (url.pathname.endsWith("/signals"))
        return Response.json({
          statuses,
          signals: Object.fromEntries(
            syms.map((s) => [
              s,
              {
                asOf: "2026-09-23",
                score: 2,
                trend: { state: "UP" },
                rsi: { value: 55, state: "NEUTRAL" },
                rvol: 1,
                macd: { state: "BULL", barsSinceCross: 4 },
                breakout: { state: "NONE" },
                range52w: { pct: 0.5, high: 200, low: 50 },
                atrPct: 2,
                flags: [],
              },
            ])
          ),
        });
      if (url.pathname.endsWith("/sparklines"))
        return Response.json({
          statuses,
          sparklines: Object.fromEntries(syms.map((s) => [s, [100, 110, 105]])),
        });
      return Response.json([]);
    };
    setReady(true);
    return () => {
      window.fetch = originalFetch;
      Storage.prototype.getItem = originalGet;
      Storage.prototype.setItem = originalSet;
      client.clear();
    };
  }, [client]);
  return (
    <Provider>
      <QueryClientProvider client={client}>
        <main className="bg-black text-white min-h-screen p-4">
          <h1>Watchlist isolated test: 1000 symbols / 1100 memberships</h1>
          <button type="button" onClick={() => setGeneration((n) => n + 1)}>
            REMOUNT PANEL
          </button>
          <pre data-testid="requests">{JSON.stringify(stats)}</pre>
          {ready && <PinnedAssets key={generation} />}
        </main>
      </QueryClientProvider>
    </Provider>
  );
}
