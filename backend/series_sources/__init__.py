"""
Indicator series collectors — the plug-in side of the generic series store.

A collector answers one question: "what does this source publish today?" It
returns observations; this module decides how they are stored, and nothing
downstream (the router, the scheduler, the UI) ever learns what the numbers
mean. Adding a source is one new file plus a `register()` call — no endpoint, no
component, no schema change.

The contract:

    class MySource:
        name = "mysource"          # stable, used in ids and in the refresh API
        group_key = "memory"       # which board in the UI it belongs to
        def collect(self) -> list[Observation]: ...

`collect()` raising is fine — the runner catches it, records the failure on the
source and leaves yesterday's rows alone. What a collector must NOT do is return
an empty list when it merely failed to parse: an empty result is read as "the
source published nothing today", which is a legitimate state (a market holiday)
and is deliberately indistinguishable from a partial one. Parsers therefore
raise on a shape they do not recognise instead of quietly returning nothing —
that is what makes a silent layout change on the publisher's side visible.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Optional, Protocol

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SeriesMeta:
    """What a series IS — stable across days."""

    id: str
    group_key: str
    label: str
    section: str = ""
    unit: str = ""
    source: str = ""
    source_url: str = ""
    freq: str = "daily"
    symbol: Optional[str] = None
    tags: str = ""
    sort_order: int = 0


@dataclass(frozen=True)
class Observation:
    """What a series WAS on one day.

    `date` is the date the PUBLISHER stamps on the number, never "today": a
    table updated at 18:10 GMT+8 and read at 02:00 local is still that day's
    print, and storing the reader's date would shift the whole series by a day
    depending on which machine happened to be awake.
    """

    meta: SeriesMeta
    date: str
    value: Optional[float]
    high: Optional[float] = None
    low: Optional[float] = None
    change_pct: Optional[float] = None


class Collector(Protocol):
    name: str
    group_key: str

    def collect(self) -> list[Observation]: ...


_REGISTRY: dict[str, Collector] = {}


def register(collector: Collector) -> None:
    _REGISTRY[collector.name] = collector


def all_collectors() -> list[Collector]:
    _load_builtin()
    return list(_REGISTRY.values())


def get_collector(name: str) -> Optional[Collector]:
    _load_builtin()
    return _REGISTRY.get(name)


_loaded = False


def _load_builtin() -> None:
    """Import the collectors that ship with the repo, once."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    from . import dramexchange  # noqa: F401  (registers itself on import)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def store(observations: Iterable[Observation]) -> dict:
    """Upsert observations, returning what changed.

    Points are written on their natural key (series_id, date), so re-running a
    collector on the same day is a replace rather than a duplicate — which is
    what lets the scheduler re-read a table after the publisher's update time
    without having to know whether it already ran.
    """
    from db import get_db

    rows = list(observations)
    if not rows:
        return {"series": 0, "points": 0}

    seen_meta: dict[str, SeriesMeta] = {}
    latest: dict[str, tuple[str, Optional[float]]] = {}
    written = 0

    with get_db() as conn:
        for ob in rows:
            m = ob.meta
            seen_meta.setdefault(m.id, m)
            conn.execute(
                """INSERT INTO series_points
                       (series_id, date, value, high, low, change_pct, captured_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(series_id, date) DO UPDATE SET
                       value = excluded.value,
                       high = excluded.high,
                       low = excluded.low,
                       change_pct = excluded.change_pct,
                       captured_at = excluded.captured_at""",
                (m.id, ob.date, ob.value, ob.high, ob.low, ob.change_pct, _now()),
            )
            written += 1
            if ob.date >= latest.get(m.id, ("", None))[0]:
                latest[m.id] = (ob.date, ob.value)

        for sid, m in seen_meta.items():
            last_date, last_value = latest.get(sid, (None, None))
            conn.execute(
                """INSERT INTO series_meta
                       (id, group_key, section, label, unit, source, source_url, freq,
                        symbol, tags, sort_order, first_seen, last_value, last_date, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(id) DO UPDATE SET
                       group_key = excluded.group_key,
                       section = excluded.section,
                       label = excluded.label,
                       unit = excluded.unit,
                       source = excluded.source,
                       source_url = excluded.source_url,
                       freq = excluded.freq,
                       symbol = excluded.symbol,
                       tags = excluded.tags,
                       sort_order = excluded.sort_order,
                       last_value = excluded.last_value,
                       last_date = excluded.last_date,
                       updated_at = excluded.updated_at""",
                (
                    m.id, m.group_key, m.section, m.label, m.unit, m.source, m.source_url,
                    m.freq, m.symbol, m.tags, m.sort_order, _now(), last_value, last_date, _now(),
                ),
            )

    return {"series": len(seen_meta), "points": written}


@dataclass
class RunResult:
    source: str
    ok: bool
    series: int = 0
    points: int = 0
    error: str = ""
    dates: list[str] = field(default_factory=list)


def run(name: Optional[str] = None) -> list[RunResult]:
    """Run one collector, or every registered one. Never raises."""
    out: list[RunResult] = []
    collectors = (
        [c] if (c := get_collector(name)) else [] if name else all_collectors()
    )
    if name and not collectors:
        return [RunResult(source=name, ok=False, error=f"no collector named '{name}'")]

    for col in collectors:
        try:
            obs = col.collect()
            stats = store(obs)
            out.append(
                RunResult(
                    source=col.name,
                    ok=True,
                    series=stats["series"],
                    points=stats["points"],
                    dates=sorted({o.date for o in obs}),
                )
            )
        except Exception as exc:  # a broken source must not stop the others
            logger.warning("series collector %s failed: %s", col.name, exc)
            out.append(RunResult(source=col.name, ok=False, error=f"{type(exc).__name__}: {exc}"))
    return out
