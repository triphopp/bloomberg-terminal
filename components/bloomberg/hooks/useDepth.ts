"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type DEPTH_CHOICES, type DepthBook, buildLadder, isDepthSymbol } from "../lib/depth-book";

export type DepthErrorCode =
  | "keys"
  | "token_missing"
  | "token_pending"
  | "subscription"
  | "unsupported"
  | "empty"
  | "rate_limit"
  | "upstream";

export class DepthError extends Error {
  code: DepthErrorCode;
  status: number;
  constructor(message: string, code: DepthErrorCode, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface WebullStatus {
  configured: boolean;
  host: string;
  environment: "production" | "test" | "custom";
  token: { status: string; expires_at: number | null; checked_at: number | null } | null;
}

async function read<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body as T;
  const detail = body?.detail;
  throw new DepthError(
    detail?.message ?? (typeof detail === "string" ? detail : body?.error) ?? `HTTP ${res.status}`,
    detail?.code ?? "upstream",
    res.status
  );
}

/** How long to wait before asking again, by what the last answer was. */
function cadence(error: DepthError | null): number | false {
  if (!error) return 2_000;
  if (error.code === "token_pending") return 5_000; // the owner is typing the SMS code
  if (error.code === "keys" || error.code === "token_missing" || error.code === "unsupported")
    return false; // nothing changes until someone acts
  return 20_000; // the backend holds a refusal that long anyway
}

/** Shared compact/expanded state; nothing is requested until the DEPTH tab is open. */
export function useDepth(symbol: string | null, enabled: boolean) {
  const [depth, setDepth] = useState<(typeof DEPTH_CHOICES)[number]>(10);
  const [overnight, setOvernight] = useState(false);
  const qc = useQueryClient();
  const supported = isDepthSymbol(symbol);

  const status = useQuery<WebullStatus, DepthError>({
    queryKey: ["webull", "status"],
    queryFn: ({ signal }) => fetch("/api/webull/status", { signal }).then((r) => read(r)),
    enabled,
    staleTime: 30_000,
  });

  const book = useQuery<DepthBook, DepthError>({
    queryKey: ["webull", "depth", symbol, depth, overnight],
    queryFn: ({ signal }) =>
      fetch(
        `/api/webull/depth?symbol=${encodeURIComponent(symbol ?? "")}&depth=${depth}&overnight=${overnight}`,
        { signal }
      ).then((r) => read<DepthBook>(r)),
    enabled: enabled && supported && status.data?.configured === true,
    refetchInterval: (q) => cadence(q.state.error),
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 1_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["webull", "status"] });
    qc.invalidateQueries({ queryKey: ["webull", "depth"] });
  };
  const requestToken = useMutation<unknown, DepthError>({
    mutationFn: () => fetch("/api/webull/token", { method: "POST" }).then((r) => read(r)),
    onSettled: refresh,
  });
  const checkToken = useMutation<unknown, DepthError>({
    mutationFn: () => fetch("/api/webull/token/check", { method: "POST" }).then((r) => read(r)),
    onSettled: refresh,
  });

  const data = book.data?.symbol === symbol ? book.data : undefined;
  const ladder = useMemo(() => (data ? buildLadder(data, depth) : null), [data, depth]);

  return {
    symbol,
    supported,
    status: status.data,
    statusLoading: status.isLoading,
    book: data,
    ladder,
    loading: book.isLoading,
    // A refusal replaces the ladder; a blip between two good polls does not.
    error: book.error && (!data || book.error.code !== "upstream") ? book.error : null,
    depth,
    setDepth,
    overnight,
    setOvernight,
    requestToken,
    checkToken,
  };
}
