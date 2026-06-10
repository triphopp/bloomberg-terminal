"use client";

import {
  QueryClient,
  QueryClientProvider as ReactQueryClientProvider,
} from "@tanstack/react-query";
import { useState } from "react";

export function QueryClientProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Configure default options for all queries
            staleTime: 1000 * 60, // 60s — aligned with Python backend CACHE_TTL=60
            gcTime: 1000 * 60 * 60, // 1 hour
            refetchOnWindowFocus: false,
            refetchOnReconnect: true,
            refetchIntervalInBackground: false,
            retry: 1,
            retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000), // Exponential backoff
            // Enable structural sharing for better performance
            structuralSharing: true,
          },
          mutations: {
            // Configure default options for all mutations
            retry: 2,
            retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10000),
            // Optimistic updates will be handled at the component level
          },
        },
      })
  );

  return <ReactQueryClientProvider client={queryClient}>{children}</ReactQueryClientProvider>;
}
