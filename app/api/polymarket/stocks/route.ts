import { marketDataProxy } from "@/lib/market-data-proxy";

export function GET(request: Request) {
  return marketDataProxy(
    `/api/polymarket/stocks?${new URL(request.url).searchParams}`,
    request.signal,
    request
  );
}
