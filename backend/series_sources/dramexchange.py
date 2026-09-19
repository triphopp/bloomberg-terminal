"""
DRAMeXchange (TrendForce) — memory spot and contract prices.

What is public, checked 2026-09-19:

  * **Spot tables on the home page**, server-rendered HTML with stable tbody
    ids: DRAM, NAND flash, module, memory card. Columns are Item / High / Low /
    Session High / Session Low / Session Average / Change %, and each table
    carries its own "Last Update: Sep.18 2026 18:10 (GMT+8)" stamp.
  * **Contract prices as JSON**: `/Home/HomePrice?Source=<name>` returns rows
    with `show_day`, `show_hi`, `show_lo`, `show_avg`, `show_avg_change`. This is
    the site's own AJAX feed — better than scraping, and it carries the date the
    contract was settled rather than the date we happened to read it.

What is NOT public: LPDDR, GDDR and wafer spot pages (302 → member login), and
**the historical charts** — `chart.dramexchange.com/chart.php` answers "Only for
MI members". That is the whole reason this collector exists: the history has to
be accumulated a day at a time on our side, exactly like `iv_snapshots`. There is
no back-fill, so a day nobody recorded stays a hole for good.

Manners: one page + a few small JSON calls, once a day (see series_scheduler),
an identifying User-Agent and a short timeout. The member area is never touched.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

import requests

from . import Observation, SeriesMeta, register

HOME = "https://www.dramexchange.com/"
JSON_URL = "https://www.dramexchange.com/Home/HomePrice"
UA = "bloomberg-terminal/1.0 (personal research dashboard; daily single fetch)"
TIMEOUT = 25

GROUP = "memory"

#: tbody id → (section label, id prefix, sort base). Only tables that actually
#: carry prices on the public page; the rest of the page lists product names
#: whose prices live behind the member wall.
SPOT_TABLES: dict[str, tuple[str, str, int]] = {
    "tb_NationalDramSpotPrice": ("DRAM SPOT", "dx.spot.dram", 100),
    "tb_NationalFlashSpotPrice": ("NAND FLASH SPOT", "dx.spot.nand", 200),
    "tb_ModuleSpotPrice": ("MODULE SPOT", "dx.spot.module", 300),
    "tb_MemCardSpotPrice": ("MEMORY CARD SPOT", "dx.spot.memcard", 400),
}

#: HomePrice `Source` → (section label, id prefix, sort base, unit).
CONTRACT_FEEDS: dict[str, tuple[str, str, int, str]] = {
    "NationalDramContract": ("DRAM CONTRACT", "dx.contract.dram", 500, "USD"),
    "NationalFlashContract": ("NAND CONTRACT", "dx.contract.nand", 600, "USD"),
    "PCC": ("SSD CONTRACT", "dx.contract.ssd", 700, "USD"),
}

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    )
}


class ParseError(RuntimeError):
    """The page no longer looks like what this parser was written against.

    Raised rather than returning nothing: an empty result means "the source
    published nothing today", which is a real and different state.
    """


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", text.strip().lower()).strip("_")
    return s[:60] or "item"


def _strip_tags(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def _num(text: str) -> Optional[float]:
    m = re.search(r"-?\d+(?:\.\d+)?", (text or "").replace(",", ""))
    return float(m.group(0)) if m else None


_STAMP = re.compile(r"Last Update:\s*([A-Z][a-z]{2})\.?\s*(\d{1,2})[, ]+(\d{4})")


def _stamp_to_date(match: re.Match) -> Optional[str]:
    mon = _MONTHS.get(match.group(1))
    if not mon:
        return None
    return f"{int(match.group(3)):04d}-{mon:02d}-{int(match.group(2)):02d}"


def _table_date(html: str, tbody_id: str) -> Optional[str]:
    """The publisher's own 'Last Update: Sep.18 2026 18:10 (GMT+8)' for a table.

    Preferred: the stamp sits in a `<td id="<name>_show_day">` above the table,
    so it is looked up by name. The module table has no such id, so the fallback
    is the last stamp appearing BEFORE the table in document order — each table
    on the page is introduced by its own stamp, and the tables carry different
    dates (spot moves daily, modules weekly), so taking any other one would
    silently misdate a whole section.
    """
    name = tbody_id.removeprefix("tb_")
    m = re.search(
        rf'id="{re.escape(name)}_show_day".{{0,400}}?Last Update:\s*'
        r"([A-Z][a-z]{2})\.?\s*(\d{1,2})[, ]+(\d{4})",
        html,
        re.S,
    )
    if m:
        return _stamp_to_date(m)

    start = html.find(f'<tbody id="{tbody_id}">')
    if start == -1:
        return None
    before = [x for x in _STAMP.finditer(html, 0, start)]
    return _stamp_to_date(before[-1]) if before else None


def _parse_spot_table(html: str, tbody_id: str) -> list[tuple[str, dict]]:
    """Rows of one spot table as (item, {column: cell text}).

    Columns are read from the header row rather than by index: the module table
    says "Weekly High" where the DRAM one says "Daily High", and a positional
    parser would silently mislabel them the day a column is inserted.
    """
    m = re.search(rf'<tbody id="{re.escape(tbody_id)}">(.*?)</tbody>', html, re.S)
    if not m:
        raise ParseError(f"table '{tbody_id}' not found on the page")
    body = m.group(1)
    rows = re.findall(r"<tr\b[^>]*>(.*?)</tr>", body, re.S)
    if not rows:
        raise ParseError(f"table '{tbody_id}' has no rows")

    header = [_strip_tags(c) for c in re.findall(r"<td[^>]*class=\"tab_title\"[^>]*>(.*?)</td>", rows[0], re.S)]
    if not header or header[0].lower() != "item":
        # Not a priced table (several blocks on the page only list product
        # names). The caller decides whether that is fatal.
        return []

    out: list[tuple[str, dict]] = []
    for raw in rows[1:]:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", raw, re.S)
        if len(cells) < 2:
            continue
        values = [_strip_tags(c) for c in cells]
        item = values[0]
        if not item:
            continue
        row = {header[i]: values[i] for i in range(min(len(header), len(values)))}
        # The change cell holds an up/down gif; the sign lives in the image name,
        # not in the text, so "1.39 %" under down.gif means −1.39.
        change_idx = next((i for i, h in enumerate(header) if "change" in h.lower()), None)
        if change_idx is not None and change_idx < len(cells):
            down = "down" in cells[change_idx].lower()
            n = _num(values[change_idx])
            row["_change"] = None if n is None else (-n if down else n)
        out.append((item, row))
    return out


def _pick(row: dict, *names: str) -> Optional[float]:
    for key, val in row.items():
        if any(n.lower() in key.lower() for n in names):
            n = _num(val)
            if n is not None:
                return n
    return None


def _spot_observations(html: str) -> list[Observation]:
    obs: list[Observation] = []
    for tbody_id, (section, prefix, base) in SPOT_TABLES.items():
        rows = _parse_spot_table(html, tbody_id)
        if not rows:
            continue
        date = _table_date(html, tbody_id)
        if not date:
            # Without the publisher's date the point cannot be placed on the
            # series honestly, so the table is skipped rather than stamped with
            # the reader's clock.
            continue
        for i, (item, row) in enumerate(rows):
            avg = _pick(row, "Session Average", "Average")
            high = _pick(row, "Session High", "Daily High", "Weekly High", "High")
            low = _pick(row, "Session Low", "Daily Low", "Weekly Low", "Low")
            if avg is None and high is None and low is None:
                continue
            obs.append(
                Observation(
                    meta=SeriesMeta(
                        id=f"{prefix}.{_slug(item)}",
                        group_key=GROUP,
                        section=section,
                        label=item,
                        unit="USD",
                        source="dramexchange",
                        source_url=HOME,
                        freq="daily",
                        tags="spot,memory",
                        sort_order=base + i,
                    ),
                    date=date,
                    value=avg if avg is not None else high,
                    high=high,
                    low=low,
                    change_pct=row.get("_change"),
                )
            )
    if not obs:
        raise ParseError("no priced spot rows parsed — the page layout changed")
    return obs


def _contract_observations(session: requests.Session) -> list[Observation]:
    obs: list[Observation] = []
    for source, (section, prefix, base, unit) in CONTRACT_FEEDS.items():
        r = session.get(
            JSON_URL, params={"Source": source, "rnd": 1}, timeout=TIMEOUT
        )
        if not r.ok:
            continue
        try:
            rows = r.json()
        except ValueError:
            continue
        if not isinstance(rows, list):
            continue
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            name = str(row.get("show_name") or row.get("Name") or "").strip()
            day = str(row.get("show_day") or "")[:10]
            avg = row.get("show_avg")
            if not name or not day or avg in (None, ""):
                continue
            obs.append(
                Observation(
                    meta=SeriesMeta(
                        id=f"{prefix}.{_slug(name)}",
                        group_key=GROUP,
                        section=section,
                        label=name,
                        unit=unit,
                        source="dramexchange",
                        source_url=HOME,
                        # Contract prices settle twice a month at most — saying
                        # "daily" would make a flat line look like stale data.
                        freq="contract",
                        tags="contract,memory",
                        sort_order=base + i,
                    ),
                    date=day,
                    value=float(avg),
                    high=_as_float(row.get("show_hi")),
                    low=_as_float(row.get("show_lo")),
                    change_pct=_as_float(row.get("show_avg_change")),
                )
            )
    return obs


def _as_float(v) -> Optional[float]:
    try:
        return None if v in (None, "") else float(v)
    except (TypeError, ValueError):
        return None


class DRAMeXchange:
    name = "dramexchange"
    group_key = GROUP

    def collect(self) -> list[Observation]:
        with requests.Session() as s:
            s.headers.update({"User-Agent": UA, "Accept-Language": "en"})
            page = s.get(HOME, timeout=TIMEOUT)
            page.raise_for_status()
            html = page.text
            obs = _spot_observations(html)
            obs += _contract_observations(s)
        return obs


register(DRAMeXchange())


if __name__ == "__main__":  # manual check: python -m series_sources.dramexchange
    import collections

    rows = DRAMeXchange().collect()
    by_section = collections.Counter(o.meta.section for o in rows)
    print(f"{len(rows)} observations")
    for section, n in by_section.items():
        sample = next(o for o in rows if o.meta.section == section)
        print(f"  {section:<20} {n:>3}  e.g. {sample.meta.label} = {sample.value} "
              f"({sample.change_pct}%) on {sample.date}")
