import { marketDataProxy } from "@/lib/market-data-proxy";

export function GET(request: Request) {
  return marketDataProxy(
    `/api/watchlist/signals?${new URL(request.url).searchParams}`,
    request.signal
  );
}
