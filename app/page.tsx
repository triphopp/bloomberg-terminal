"use client";

import { Provider } from "jotai";
import dynamic from "next/dynamic";
import { QueryClientProvider } from "../components/bloomberg/providers/query-client-provider";

/**
 * The terminal renders client-side only.
 *
 * Every panel restores its layout from localStorage in a `useState` initializer
 * (watchlist height, regime mode, column sets, …). On the server that storage
 * does not exist, so SSR emits the defaults while the very first client render
 * emits the saved values — React sees two different trees and reports a
 * hydration mismatch, which it then repairs by throwing the SSR output away.
 * The markup was never useful anyway: every number on screen arrives from React
 * Query after mount. Skipping SSR removes that whole class of mismatch instead
 * of patching each panel.
 */
const BloombergTerminal = dynamic(
  () => import("@/components/bloomberg/layout/bloomberg-terminal"),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-screen" style={{ background: "#000" }}>
        <span className="text-sm font-bold font-mono tracking-[0.3em]" style={{ color: "#ff9900" }}>
          BLOOMBERG
        </span>
      </div>
    ),
  }
);

export default function Home() {
  return (
    <Provider>
      <QueryClientProvider>
        <BloombergTerminal />
      </QueryClientProvider>
    </Provider>
  );
}
