from datetime import datetime

from sources import market_data
from .base_options import OptionContract, OptionMarketData, OptionsProvider


class YahooOptionsProvider(OptionsProvider):
    @property
    def source_name(self) -> str:
        return "yahoo_finance"

    @property
    def is_realtime(self) -> bool:
        return False

    @property
    def delay_minutes(self) -> int:
        return 15

    async def get_expirations(self, underlying: str) -> list[str]:
        t = market_data.get_ticker(underlying.upper())
        return list(t.options or [])

    async def get_market_data(self, contract: OptionContract) -> OptionMarketData | None:
        t = market_data.get_ticker(contract.underlying.upper())
        expirations = t.options or []
        if contract.expiry not in expirations:
            return None

        chain = t.option_chain(contract.expiry)
        df = chain.calls if contract.option_type == "call" else chain.puts
        row = df[df["strike"] == contract.strike]
        if row.empty:
            return None

        r = row.iloc[0]

        def _f(col: str) -> float | None:
            v = r.get(col)
            if v is None:
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        def _i(col: str) -> int | None:
            v = r.get(col)
            if v is None:
                return None
            try:
                return int(v)
            except (TypeError, ValueError):
                return None

        return OptionMarketData(
            contract=contract,
            freshness=self.make_freshness(),
            last_price=_f("lastPrice"),
            bid=_f("bid"),
            ask=_f("ask"),
            implied_volatility=_f("impliedVolatility"),
            # Yahoo Finance does not provide Greeks directly — delta/gamma/theta calculated
            # externally via Black-Scholes if needed; set None to avoid misleading values
            delta=None,
            gamma=None,
            theta=None,
            vega=None,
            volume=_i("volume"),
            open_interest=_i("openInterest"),
            in_the_money=bool(r.get("inTheMoney")),
        )

    async def get_chain(self, underlying: str, expiry: str) -> dict:
        t = market_data.get_ticker(underlying.upper())
        chain = t.option_chain(expiry)
        freshness = self.make_freshness().__dict__
        return {
            "calls": chain.calls.to_dict("records"),
            "puts": chain.puts.to_dict("records"),
            "freshness": freshness,
        }
