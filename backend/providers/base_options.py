from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class OptionContract:
    underlying: str
    expiry: str        # "YYYY-MM-DD"
    strike: float
    option_type: str   # "call" | "put"


@dataclass
class DataFreshness:
    fetched_at: str          # ISO 8601 UTC
    is_realtime: bool
    source: str              # "yahoo_finance" | "alpha_vantage" | "polygon" | "manual"
    delay_minutes: int = 0   # 0 = realtime
    warning: str = ""        # shown in tooltip


@dataclass
class OptionMarketData:
    contract: OptionContract
    freshness: DataFreshness
    last_price: float | None = None
    bid: float | None = None
    ask: float | None = None
    implied_volatility: float | None = None
    delta: float | None = None
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    volume: int | None = None
    open_interest: int | None = None
    in_the_money: bool | None = None


class OptionsProvider(ABC):
    @abstractmethod
    async def get_expirations(self, underlying: str) -> list[str]: ...

    @abstractmethod
    async def get_market_data(self, contract: OptionContract) -> OptionMarketData | None: ...

    @abstractmethod
    async def get_chain(self, underlying: str, expiry: str) -> dict: ...

    @property
    @abstractmethod
    def source_name(self) -> str: ...

    @property
    @abstractmethod
    def is_realtime(self) -> bool: ...

    @property
    @abstractmethod
    def delay_minutes(self) -> int: ...

    def make_freshness(self) -> DataFreshness:
        warning = (
            "" if self.is_realtime
            else f"~{self.delay_minutes} min delayed data ({self.source_name}). Not suitable for active trading."
        )
        return DataFreshness(
            fetched_at=datetime.utcnow().isoformat() + "Z",
            is_realtime=self.is_realtime,
            source=self.source_name,
            delay_minutes=self.delay_minutes,
            warning=warning,
        )
