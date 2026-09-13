"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  type IvSmileChain,
  type SmileFitMode,
  type SmileSide,
  type SmileTenor,
  type SviFitResponse,
  buildIvSmile,
  chooseSmileExpiry,
  expiryDays,
  selectSmileTenors,
  smileSamples,
} from "../lib/iv-smile";

class ChainError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function fetchChain(symbol: string, expiry: string | undefined, signal: AbortSignal) {
  const params = new URLSearchParams({ symbol });
  if (expiry) params.set("expiry", expiry);
  const res = await fetch(`/api/options?${params}`, { signal });
  const body = await res.json();
  if (!res.ok)
    throw new ChainError(body.error ?? `Options request failed (${res.status})`, res.status);
  if (
    body.symbol !== symbol ||
    !Array.isArray(body.calls) ||
    !Array.isArray(body.puts) ||
    !Array.isArray(body.expirations) ||
    typeof body.expiry !== "string"
  )
    throw new ChainError("Invalid options response", 502);
  if (expiry && body.expiry !== expiry)
    throw new ChainError("Selected expiry is no longer available. Choose another expiry.", 422);
  return body as IvSmileChain;
}

/** Shared compact/expanded state; chain and fit requests start only on the IV tab. */
export function useIvSmile(symbol: string | null, enabled: boolean) {
  const [selection, setSelection] = useState<{ symbol: string; expiry: string } | null>(null);
  const [rangePercent, setRangePercent] = useState(25);
  const [quotedOnly, setQuotedOnly] = useState(true);
  const [fitMode, setFitMode] = useState<SmileFitMode>("observed");
  const [showPoints, setShowPoints] = useState(true);
  const [showOi, setShowOi] = useState(false);
  const [oiSelection, setOiSelection] = useState<{ symbol: string; expiry: string } | null>(null);
  const [side, setSide] = useState<SmileSide>("both");
  const [compare, setCompare] = useState(false);
  const [months, setMonths] = useState<number[]>([1, 3, 5, 7, 9]);
  const retry = (attempt: number, error: Error) =>
    !(error instanceof ChainError && error.status < 500) && attempt < 1;
  const discovery = useQuery<IvSmileChain, Error>({
    queryKey: ["options", "chain", symbol, "default"],
    queryFn: ({ signal }) => fetchChain(symbol ?? "", undefined, signal),
    enabled: enabled && !!symbol,
    staleTime: 5 * 60_000,
    retry,
  });
  const available = discovery.data?.symbol === symbol ? discovery.data : undefined;
  const expiry =
    selection?.symbol === symbol &&
    available?.expirations.includes(selection.expiry) &&
    expiryDays(selection.expiry) >= 0
      ? selection.expiry
      : chooseSmileExpiry(available?.expirations ?? []);
  const tenors: SmileTenor[] = compare
    ? selectSmileTenors(available?.expirations ?? [], months)
    : expiry
      ? [{ months: [], expiry, days: expiryDays(expiry) }]
      : [];
  const chains = useQueries({
    queries: tenors.map((tenor) => ({
      queryKey: ["options", "chain", symbol, tenor.expiry ?? `missing-${tenor.months.join("-")}`],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchChain(symbol ?? "", tenor.expiry ?? undefined, signal),
      enabled: enabled && !!symbol && !!tenor.expiry && tenor.expiry !== available?.expiry,
      staleTime: 5 * 60_000,
      retry,
    })),
  });
  const slices = tenors.map((tenor, index) => {
    const query = tenor.expiry === available?.expiry ? discovery : chains[index];
    const chain =
      query.data?.symbol === symbol && query.data?.expiry === tenor.expiry ? query.data : undefined;
    const prepared = chain ? buildIvSmile(chain, rangePercent, quotedOnly) : null;
    const samples = prepared && chain ? smileSamples(prepared.points, side, chain.spot) : [];
    const timeYears = tenor.days != null ? tenor.days / 365 : 0;
    return {
      ...tenor,
      data: chain,
      prepared,
      samples,
      timeYears,
      dataVersion: query.dataUpdatedAt,
      loading: !!tenor.expiry && query.isPending,
      fetching: query.isFetching,
      error: tenor.expiry ? query.error : null,
    };
  });
  const fits = useQueries({
    queries: slices.map((slice) => ({
      queryKey: [
        "options",
        "smile-fit",
        "raw-svi-v1",
        symbol,
        slice.expiry ?? `missing-${slice.months.join("-")}`,
        slice.dataVersion,
        rangePercent,
        quotedOnly,
        side,
        slice.timeYears,
      ],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SviFitResponse> => {
        const res = await fetch("/api/options/smile-fit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            referencePrice: slice.data?.spot,
            timeYears: slice.timeYears,
            series: slice.samples,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `SVI fit failed (${res.status})`);
        return body;
      },
      enabled:
        enabled &&
        fitMode === "raw_svi" &&
        !!slice.data &&
        slice.data.spot > 0 &&
        slice.timeYears > 0,
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const error = discovery.error;
  return {
    symbol,
    expiry,
    rangePercent,
    setRangePercent,
    quotedOnly,
    setQuotedOnly,
    fitMode,
    setFitMode,
    showPoints,
    setShowPoints,
    showOi,
    setShowOi,
    oiExpiry:
      oiSelection?.symbol === symbol && slices.some((s) => s.expiry === oiSelection.expiry)
        ? oiSelection.expiry
        : slices.find((s) => s.expiry)?.expiry,
    selectOiExpiry: (expiry: string) => {
      if (symbol) setOiSelection({ symbol, expiry });
    },
    side,
    setSide,
    compare,
    setCompare,
    months,
    toggleMonth: (month: number) =>
      setMonths((prev) =>
        prev.includes(month)
          ? prev.length > 1
            ? prev.filter((m) => m !== month)
            : prev
          : [...prev, month].sort((a, b) => a - b)
      ),
    slices: slices.map((slice, index) => ({
      ...slice,
      fit: fitMode === "raw_svi" ? fits[index].data : undefined,
      fitLoading:
        fitMode === "raw_svi" &&
        !!slice.data &&
        slice.data.spot > 0 &&
        slice.timeYears > 0 &&
        fits[index].isPending,
      fitError: fitMode === "raw_svi" ? fits[index].error : null,
    })),
    expirations: available?.expirations ?? [],
    loading: enabled && !!symbol && discovery.isPending,
    fetching:
      discovery.isFetching || slices.some((s) => s.fetching) || fits.some((f) => f.isFetching),
    error,
    noOptions: error instanceof ChainError && error.status === 404,
    selectExpiry: (value: string) => {
      if (symbol) setSelection({ symbol, expiry: value });
    },
    refresh: () => {
      void discovery.refetch();
      chains.forEach((query, index) => {
        if (tenors[index].expiry && tenors[index].expiry !== available?.expiry)
          void query.refetch();
      });
    },
  };
}
