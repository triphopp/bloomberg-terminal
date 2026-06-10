"""
Central Bank Open APIs router — aggregates data from central banks with free public APIs.
No API keys required for any source in this file.

Sources:
  Group A (SDMX): ECB, Bundesbank, Norges Bank
  Group B (REST/JSON): Bank of Canada, SNB, BOJ, SARB, Bank of Russia
  Group C (CSV/HTML): Bank of England, RBA
  Group D (Supranational): Eurostat
  (Banco de España and OeNB data is mostly covered by ECB — included as aliases)
"""
import csv
import io
import json
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from fastapi import APIRouter, HTTPException, Query

import circuit_breaker as cb

from config import MEM_CACHE_TTL, DEFAULT_HTTP_TIMEOUT, CENTRAL_BANK_URLS

router = APIRouter()

# ── Cache ────────────────────────────────────────────────────────────────────
_CB_CACHE_FILE = Path(__file__).parent.parent / "central_banks_cache.json"
_cb_mem: dict[str, Any] = {}
_MEM_TTL = MEM_CACHE_TTL
_DISK_TTL = 4 * 3600  # 4 hours default (most data is daily)
_DISK_TTL_SLOW = 7 * 86400  # 7 days for annual/quarterly data

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "BloombergTerminal/1.0"})
_TIMEOUT = DEFAULT_HTTP_TIMEOUT


def _load_cache() -> dict:
    try:
        if _CB_CACHE_FILE.exists():
            return json.loads(_CB_CACHE_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_cache(cache: dict) -> None:
    try:
        _CB_CACHE_FILE.write_text(
            json.dumps(cache, separators=(",", ":")), encoding="utf-8"
        )
    except Exception:
        pass


def _is_fresh(entry: dict | None, ttl: int | None = None) -> bool:
    if not entry:
        return False
    t = ttl or entry.get("ttl", _DISK_TTL)
    return time.time() - entry.get("ts", 0) < t


# ── Bank Registry ────────────────────────────────────────────────────────────
# Each bank entry defines metadata + which data categories it supports.

BANKS: dict[str, dict] = {
    "ecb": {
        "name": "European Central Bank",
        "country": "EU",
        "flag": "🇪🇺",
        "api_type": "sdmx",
        "base_url": "https://data-api.ecb.europa.eu/service",
        "auth": None,
        "categories": ["policy_rate", "fx", "inflation", "yield_curve", "money_supply", "balance_of_payments"],
    },
    "boe": {
        "name": "Bank of England",
        "country": "GB",
        "flag": "🇬🇧",
        "api_type": "csv",
        "base_url": "https://www.bankofengland.co.uk/boeapps/database",
        "auth": None,
        "categories": ["policy_rate"],
        "note": "IADB CSV API deprecated; rate scraped from BoE website. FX via yfinance.",
    },
    "boc": {
        "name": "Bank of Canada",
        "country": "CA",
        "flag": "🇨🇦",
        "api_type": "json",
        "base_url": "https://www.bankofcanada.ca/valet",
        "auth": None,
        "categories": ["policy_rate", "fx", "bond_yields"],
    },
    "norges": {
        "name": "Norges Bank",
        "country": "NO",
        "flag": "🇳🇴",
        "api_type": "sdmx",
        "base_url": "https://data.norges-bank.no/api",
        "auth": None,
        "categories": ["policy_rate", "fx", "bond_yields"],
    },
    "bundesbank": {
        "name": "Deutsche Bundesbank",
        "country": "DE",
        "flag": "🇩🇪",
        "api_type": "sdmx",
        "base_url": "https://api.statistiken.bundesbank.de/rest",
        "auth": None,
        "categories": ["fx", "inflation", "money_supply", "banking_stats", "bond_yields"],
    },
    "snb": {
        "name": "Swiss National Bank",
        "country": "CH",
        "flag": "🇨🇭",
        "api_type": "json",
        "base_url": "https://data.snb.ch/api",
        "auth": None,
        "categories": ["policy_rate", "fx", "fx_reserves", "money_supply", "inflation"],
    },
    "boj": {
        "name": "Bank of Japan",
        "country": "JP",
        "flag": "🇯🇵",
        "api_type": "json",
        "base_url": "https://www.stat-search.boj.or.jp/api",
        "auth": None,
        "categories": ["policy_rate"],
        "note": "API endpoint not yet publicly accessible (as of May 2026)",
    },
    "sarb": {
        "name": "South African Reserve Bank",
        "country": "ZA",
        "flag": "🇿🇦",
        "api_type": "json",
        "base_url": "https://custom.resbank.co.za/SarbWebApi/WebIndicators",
        "auth": None,
        "categories": ["policy_rate", "fx", "inflation", "money_supply"],
    },
    "cbr": {
        "name": "Bank of Russia",
        "country": "RU",
        "flag": "🇷🇺",
        "api_type": "xml",
        "base_url": "https://www.cbr.ru/scripts",
        "auth": None,
        "categories": ["policy_rate", "fx"],
    },
    "rba": {
        "name": "Reserve Bank of Australia",
        "country": "AU",
        "flag": "🇦🇺",
        "api_type": "scrape",
        "base_url": "https://www.rba.gov.au/statistics/cash-rate/",
        "auth": None,
        "categories": ["policy_rate"],
        "note": "CSV download blocked (403); rate scraped from website. FX via yfinance.",
    },
    "eurostat": {
        "name": "Eurostat",
        "country": "EU",
        "flag": "🇪🇺",
        "api_type": "sdmx",
        "base_url": "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1",
        "auth": None,
        "categories": ["energy_prices", "energy_balance", "renewables"],
    },
    "bde": {
        "name": "Banco de España",
        "country": "ES",
        "flag": "🇪🇸",
        "api_type": "json",
        "base_url": "https://www.bde.es/webbe/en/estadisticas",
        "auth": None,
        "categories": ["policy_rate", "banking_stats"],
        "note": "Most data available via ECB SDMX",
    },
    "oenb": {
        "name": "Oesterreichische Nationalbank",
        "country": "AT",
        "flag": "🇦🇹",
        "api_type": "sdmx",
        "base_url": "https://www.oenb.at/isaweb",
        "auth": None,
        "categories": ["fx", "banking_stats"],
        "note": "Most data available via ECB SDMX",
    },
}

# ═════════════════════════════════════════════════════════════════════════════
# FETCHERS — one per API style
# ═════════════════════════════════════════════════════════════════════════════

# ── ECB (SDMX JSON) ─────────────────────────────────────────────────────────

def _fetch_ecb_series(flow: str, key: str, start: str = "2020-01-01") -> list[dict]:
    """ECB SDMX 2.1 → [{date, value}] newest-first."""
    url = f"https://data-api.ecb.europa.eu/service/data/{flow}/{key}"
    try:
        r = _SESSION.get(url, params={"startPeriod": start, "format": "csvdata"}, timeout=_TIMEOUT)
        if not r.ok:
            return []
        reader = csv.DictReader(io.StringIO(r.text))
        rows = []
        for row in reader:
            period = row.get("TIME_PERIOD", "")
            val = row.get("OBS_VALUE", "")
            if period and val:
                try:
                    rows.append({"date": period, "value": round(float(val), 6)})
                except ValueError:
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _ecb_policy_rate() -> dict | None:
    series = _fetch_ecb_series("FM", "B.U2.EUR.4F.KR.DFR.LEV")
    if not series:
        return None
    return {
        "bank": "ecb", "name": "ECB Deposit Facility Rate",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:36],
    }


def _ecb_fx(currency: str = "USD") -> dict | None:
    series = _fetch_ecb_series("EXR", f"D.{currency}.EUR.SP00.A")
    if not series:
        return None
    return {
        "bank": "ecb", "pair": f"{currency}/EUR",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:252],
    }


def _ecb_hicp() -> dict | None:
    series = _fetch_ecb_series("ICP", "M.U2.N.000000.4.ANR")
    if not series:
        return None
    return {
        "bank": "ecb", "name": "HICP Euro Area YoY%",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:36],
    }


def _ecb_yield_curve() -> dict | None:
    maturities = {
        "3m": "M.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M",
        "1y": "M.U2.EUR.4F.G_N_A.SV_C_YM.SR_1Y",
        "2y": "M.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y",
        "5y": "M.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y",
        "10y": "M.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y",
        "30y": "M.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y",
    }
    curve = {}
    for label, key in maturities.items():
        s = _fetch_ecb_series("YC", key, start="2024-01-01")
        if s:
            curve[label] = s[0]["value"]
    if not curve:
        return None
    return {"bank": "ecb", "name": "Euro Area Yield Curve", "curve": curve, "date": datetime.utcnow().strftime("%Y-%m-%d")}


# ── Bank of England (CSV) ───────────────────────────────────────────────────

def _boe_policy_rate() -> dict | None:
    """Scrape BoE Bank Rate from their monetary policy page."""
    import re
    url = "https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate"
    try:
        r = _SESSION.get(url, timeout=_TIMEOUT)
        if not r.ok:
            return None
        # Target the "Current Bank Rate" stat figure span directly
        match = re.search(r"Current Bank Rate\s*<[^>]*>\s*([\d.]+)%", r.text, re.IGNORECASE)
        if not match:
            match = re.search(r'stat-figure">([\d.]+)%</span>', r.text)
        if not match:
            match = re.search(r"Bank Rate.*?held at\s+([\d.]+)%", r.text, re.IGNORECASE | re.DOTALL)
        if match:
            rate = round(float(match.group(1)), 4)
            return {
                "bank": "boe", "name": "Bank Rate",
                "value": rate, "date": datetime.utcnow().strftime("%Y-%m-%d"),
                "series": [],
            }
    except Exception:
        pass
    return None


# ── Bank of Canada (Valet JSON) ─────────────────────────────────────────────

def _fetch_boc_series(series_name: str) -> list[dict]:
    """BoC Valet API → [{date, value}] newest-first."""
    url = f"https://www.bankofcanada.ca/valet/observations/{series_name}/json"
    try:
        r = _SESSION.get(url, timeout=_TIMEOUT)
        if not r.ok:
            return []
        body = r.json()
        obs = body.get("observations", [])
        rows = []
        for o in obs:
            date = o.get("d", "")
            val = o.get(series_name, {})
            v = val.get("v") if isinstance(val, dict) else val
            if date and v is not None:
                try:
                    rows.append({"date": date, "value": round(float(v), 6)})
                except (ValueError, TypeError):
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _boc_policy_rate() -> dict | None:
    series = _fetch_boc_series("V39079")
    if not series:
        return None
    return {
        "bank": "boc", "name": "Overnight Rate Target",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:36],
    }


def _boc_fx(currency: str = "USD") -> dict | None:
    code_map = {"USD": "FXUSDCAD", "EUR": "FXEURCAD", "GBP": "FXGBPCAD", "JPY": "FXJPYCAD"}
    code = code_map.get(currency.upper())
    if not code:
        return None
    series = _fetch_boc_series(code)
    if not series:
        return None
    return {
        "bank": "boc", "pair": f"CAD/{currency}",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:252],
    }


# ── Norges Bank (SDMX JSON) ─────────────────────────────────────────────────

def _fetch_norges_series(flow: str, key: str, start: str = "2020-01-01") -> list[dict]:
    url = f"https://data.norges-bank.no/api/data/{flow}/{key}"
    try:
        r = _SESSION.get(url, params={"startPeriod": start, "format": "sdmx-json"}, timeout=_TIMEOUT)
        if not r.ok:
            return []
        body = r.json()
        data_root = body.get("data", body)
        ds = data_root.get("dataSets", [{}])[0]
        series_data = ds.get("series", {})
        struct = data_root.get("structure", body.get("structure", {}))
        dims = struct.get("dimensions", {}).get("observation", [])
        time_dim = None
        for d in dims:
            if d.get("id") == "TIME_PERIOD":
                time_dim = d.get("values", [])
                break
        if not time_dim or not series_data:
            return []
        rows = []
        for _sk, sv in series_data.items():
            obs = sv.get("observations", {})
            for idx_str, vals in obs.items():
                idx = int(idx_str)
                if idx < len(time_dim) and vals:
                    period = time_dim[idx].get("id", "")
                    val = vals[0] if vals else None
                    if period and val is not None:
                        rows.append({"date": period, "value": round(float(val), 6)})
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _norges_policy_rate() -> dict | None:
    series = _fetch_norges_series("IR", "B.KPRA.SD.R", start="2020-01-01")
    if not series:
        return None
    return {
        "bank": "norges", "name": "Norges Bank Policy Rate",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:36],
    }


def _norges_fx(currency: str = "USD") -> dict | None:
    series = _fetch_norges_series("EXR", f"B.{currency}.NOK.SP")
    if not series:
        return None
    return {
        "bank": "norges", "pair": f"{currency}/NOK",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:252],
    }


# ── Deutsche Bundesbank (SDMX CSV) ──────────────────────────────────────────

def _fetch_bundesbank_series(flow: str, key: str, start: str = "2020-01") -> list[dict]:
    url = f"https://api.statistiken.bundesbank.de/rest/data/{flow}/{key}"
    try:
        r = _SESSION.get(url, params={"startPeriod": start}, headers={"Accept": "text/csv"}, timeout=_TIMEOUT)
        if not r.ok:
            return []
        reader = csv.DictReader(io.StringIO(r.text), delimiter=";")
        rows = []
        for row in reader:
            period = row.get("TIME_PERIOD", "")
            val = row.get("OBS_VALUE", "")
            if period and val:
                try:
                    rows.append({"date": period, "value": round(float(val), 6)})
                except ValueError:
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _bundesbank_fx(currency: str = "USD") -> dict | None:
    series = _fetch_bundesbank_series("BBEX3", f"M.{currency}.EUR.BB.AC.A01")
    if not series:
        return None
    return {
        "bank": "bundesbank", "pair": f"{currency}/EUR",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:60],
    }


def _bundesbank_inflation() -> dict | None:
    series = _fetch_bundesbank_series("BBDP1", "M.DE.N.VPI.C.A00000.I15.A")
    if not series:
        return None
    return {
        "bank": "bundesbank", "name": "Germany CPI YoY%",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:36],
    }


# ── Swiss National Bank (JSON) ──────────────────────────────────────────────

def _fetch_snb_series(cube: str, start: str = "2020-01-01") -> list[dict]:
    url = f"https://data.snb.ch/api/cube/{cube}/data/csv/en"
    try:
        r = _SESSION.get(url, params={"startDate": start}, timeout=_TIMEOUT)
        if not r.ok:
            return []
        reader = csv.reader(io.StringIO(r.text), delimiter=";")
        header = next(reader, None)
        if not header:
            return []
        date_col = 0
        val_col = len(header) - 1
        rows = []
        for row in reader:
            if len(row) <= val_col:
                continue
            date_str = row[date_col].strip()
            val_str = row[val_col].strip()
            if date_str and val_str:
                try:
                    rows.append({"date": date_str, "value": round(float(val_str), 6)})
                except ValueError:
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _snb_policy_rate() -> dict | None:
    """SNB policy rate from snboffzisa cube. D0='LZ' = Leitzins (policy rate)."""
    url = "https://data.snb.ch/api/cube/snboffzisa/data/csv/en"
    try:
        r = _SESSION.get(url, params={"startDate": "2020-01-01"}, timeout=_TIMEOUT)
        if not r.ok:
            return None
        rows = []
        in_data = False
        for line in r.text.strip().split("\n"):
            if '"Date"' in line or line.startswith("Date"):
                in_data = True
                continue
            if not in_data:
                continue
            parts = [p.strip().strip('"').strip() for p in line.split(";")]
            if len(parts) >= 3 and parts[1] == "LZ" and parts[2].strip('"'):
                try:
                    val_str = parts[2].strip('"').strip()
                    rows.append({"date": parts[0], "value": round(float(val_str), 4)})
                except ValueError:
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        if not rows:
            return None
        return {
            "bank": "snb", "name": "SNB Policy Rate",
            "value": rows[0]["value"], "date": rows[0]["date"],
            "series": rows[:36],
        }
    except Exception:
        return None


def _snb_fx(currency: str = "USD") -> dict | None:
    """SNB devkum cube: Date;D0;D1;Value — D1 is the currency code (e.g. USD1, EUR1)."""
    url = "https://data.snb.ch/api/cube/devkum/data/csv/en"
    target_d1 = f"{currency.upper()}1"
    try:
        r = _SESSION.get(url, params={"startDate": "2020-01-01"}, timeout=_TIMEOUT)
        if not r.ok:
            return None
        in_data = False
        rows = []
        for line in r.text.strip().split("\n"):
            if '"Date"' in line or line.startswith("Date"):
                in_data = True
                continue
            if not in_data:
                continue
            parts = [p.strip().strip('"') for p in line.split(";")]
            if len(parts) >= 4 and parts[2] == target_d1 and parts[3]:
                try:
                    rows.append({"date": parts[0], "value": round(float(parts[3]), 6)})
                except ValueError:
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        if not rows:
            return None
        return {
            "bank": "snb", "pair": f"{currency}/CHF",
            "value": rows[0]["value"], "date": rows[0]["date"],
            "series": rows[:252],
        }
    except Exception:
        return None


# ── Bank of Japan (JSON) ────────────────────────────────────────────────────

def _fetch_boj_series(code: str, start: str = "2020-01-01") -> list[dict]:
    url = "https://www.stat-search.boj.or.jp/ssi/mtshtml/api/data"
    try:
        r = _SESSION.get(
            url,
            params={"code": code, "format": "json", "startDate": start.replace("-", "")},
            timeout=_TIMEOUT,
        )
        if not r.ok:
            return []
        body = r.json()
        rows = []
        for item in body if isinstance(body, list) else body.get("data", []):
            date = item.get("date", "")
            val = item.get("value")
            if date and val is not None:
                try:
                    d = f"{date[:4]}-{date[4:6]}-{date[6:8]}" if len(date) == 8 else date
                    rows.append({"date": d, "value": round(float(val), 6)})
                except (ValueError, IndexError):
                    pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _boj_policy_rate() -> dict | None:
    series = _fetch_boj_series("IR01'MADR1Z@D")
    if not series:
        return None
    return {
        "bank": "boj", "name": "BOJ Basic Discount Rate",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:36],
    }


# ── SARB (JSON) ─────────────────────────────────────────────────────────────

def _sarb_policy_rate() -> dict | None:
    url = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/CurrentMarketRates"
    try:
        r = _SESSION.get(url, timeout=_TIMEOUT)
        if not r.ok:
            return None
        body = r.json()
        if not isinstance(body, list):
            return None
        for item in body:
            name = item.get("Name", "")
            if "Policy Rate" in name or "Repo" in name:
                return {
                    "bank": "sarb", "name": name,
                    "value": round(float(item.get("Value", 0)), 4),
                    "date": item.get("Date", ""),
                    "series": [],
                }
    except Exception:
        pass
    return None


# ── Bank of Russia (XML) ────────────────────────────────────────────────────

def _cbr_key_rate() -> dict | None:
    """Fetch CBR key rate via SOAP service (POST required)."""
    import re
    from datetime import datetime as _dt, timedelta
    soap_url = "https://www.cbr.ru/DailyInfoWebServ/DailyInfo.asmx"
    now = _dt.utcnow()
    start = (now - timedelta(days=365)).strftime("%Y-%m-%dT00:00:00")
    end = now.strftime("%Y-%m-%dT00:00:00")
    soap_body = f"""<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:web="http://web.cbr.ru/">
  <soap:Body>
    <web:KeyRate>
      <web:fromDate>{start}</web:fromDate>
      <web:ToDate>{end}</web:ToDate>
    </web:KeyRate>
  </soap:Body>
</soap:Envelope>"""
    try:
        r = _SESSION.post(
            soap_url, data=soap_body.encode("utf-8"),
            headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://web.cbr.ru/KeyRate"},
            timeout=_TIMEOUT,
        )
        if not r.ok:
            return None
        content = r.content.decode("utf-8", errors="replace")
        # Parse rates from SOAP response — extract <DT> and <Rate> pairs
        dates = re.findall(r"<DT>([^<]+)</DT>", content)
        rates = re.findall(r"<Rate>([^<]+)</Rate>", content)
        rows = []
        for d, v in zip(dates, rates):
            try:
                iso = d[:10]
                rows.append({"date": iso, "value": round(float(v), 4)})
            except (ValueError, IndexError):
                pass
        rows.sort(key=lambda x: x["date"], reverse=True)
        if not rows:
            return None
        return {
            "bank": "cbr", "name": "CBR Key Rate",
            "value": rows[0]["value"], "date": rows[0]["date"],
            "series": rows[:36],
        }
    except Exception:
        return None


def _cbr_fx(currency: str = "USD") -> dict | None:
    url = "https://www.cbr.ru/scripts/XML_daily_eng.asp"
    try:
        r = _SESSION.get(url, timeout=_TIMEOUT)
        if not r.ok:
            return None
        root = ET.fromstring(r.content)
        date_str = root.attrib.get("Date", "")
        for valute in root.findall(".//Valute"):
            char_code = valute.findtext("CharCode", "")
            if char_code.upper() == currency.upper():
                nominal = float(valute.findtext("Nominal", "1").replace(",", "."))
                value = float(valute.findtext("Value", "0").replace(",", "."))
                rate = round(value / nominal, 4) if nominal else 0
                parts = date_str.split(".")
                iso = f"{parts[2]}-{parts[1]}-{parts[0]}" if len(parts) == 3 else date_str
                return {
                    "bank": "cbr", "pair": f"{currency}/RUB",
                    "value": rate, "date": iso, "series": [],
                }
    except Exception:
        pass
    return None


# ── RBA (CSV download) ──────────────────────────────────────────────────────

def _rba_cash_rate() -> dict | None:
    """Fetch RBA cash rate from their RSS/JSON feed."""
    import re
    url = "https://www.rba.gov.au/statistics/cash-rate/"
    try:
        r = _SESSION.get(url, timeout=_TIMEOUT, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html",
        })
        if not r.ok:
            return None
        match = re.search(r"cash rate target.*?([\d.]+)\s*per\s*cent", r.text, re.IGNORECASE | re.DOTALL)
        if not match:
            match = re.search(r"([\d.]+)\s*%", r.text[:5000])
        if match:
            rate = round(float(match.group(1)), 4)
            return {
                "bank": "rba", "name": "RBA Cash Rate Target",
                "value": rate, "date": datetime.utcnow().strftime("%Y-%m-%d"),
                "series": [],
            }
    except Exception:
        pass
    return None


# ── Eurostat (SDMX JSON) ────────────────────────────────────────────────────

def _fetch_eurostat_series(dataset: str, params: dict | None = None) -> list[dict]:
    url = f"https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/{dataset}"
    default_params = {"format": "JSON", "lang": "EN"}
    if params:
        default_params.update(params)
    try:
        r = _SESSION.get(url, params=default_params, timeout=15)
        if not r.ok:
            return []
        body = r.json()
        dims = body.get("dimension", {})
        time_dim = dims.get("time", {}).get("category", {}).get("index", {})
        values = body.get("value", {})
        if not time_dim or not values:
            return []
        time_labels = sorted(time_dim.items(), key=lambda x: x[1])
        rows = []
        for period, idx in time_labels:
            val = values.get(str(idx))
            if val is not None:
                rows.append({"date": period, "value": round(float(val), 4)})
        rows.sort(key=lambda x: x["date"], reverse=True)
        return rows
    except Exception:
        return []


def _eurostat_energy_prices() -> dict | None:
    series = _fetch_eurostat_series("nrg_pc_202", {"startPeriod": "2020-S1"})
    if not series:
        return None
    return {
        "bank": "eurostat", "name": "EU Electricity Prices (Household)",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:20],
    }


def _eurostat_renewables() -> dict | None:
    series = _fetch_eurostat_series("nrg_ind_ren", {"startPeriod": "2015"})
    if not series:
        return None
    return {
        "bank": "eurostat", "name": "EU Renewable Energy Share %",
        "value": series[0]["value"], "date": series[0]["date"],
        "series": series[:20],
    }


# ═════════════════════════════════════════════════════════════════════════════
# AGGREGATE FETCHERS — cross-bank comparisons
# ═════════════════════════════════════════════════════════════════════════════

_RATE_FETCHERS: dict[str, callable] = {
    "ecb":        _ecb_policy_rate,
    "boe":        _boe_policy_rate,
    "boc":        _boc_policy_rate,
    "norges":     _norges_policy_rate,
    "snb":        _snb_policy_rate,
    "sarb":       _sarb_policy_rate,
    "cbr":        _cbr_key_rate,
    # "rba": blocked — needs readrba package or browser automation
}


def _fetch_all_rates() -> tuple[list[dict], dict[str, str]]:
    """Fetch policy rates from all banks concurrently.
    Returns (results_list, sources_map) where sources_map is {bank_id: "ok"|"error"|"skipped"}.
    """
    results = []
    sources: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=min(len(_RATE_FETCHERS), 6)) as pool:
        futs = {}
        for bank, fn in _RATE_FETCHERS.items():
            if cb.allow(bank):
                futs[bank] = pool.submit(fn)
            else:
                sources[bank] = "skipped"
        for bank, fut in futs.items():
            try:
                data = fut.result(timeout=15)
                if data:
                    cb.success(bank)
                    sources[bank] = "ok"
                    meta = BANKS[bank]
                    data["flag"] = meta["flag"]
                    data["country"] = meta["country"]
                    data["bank_name"] = meta["name"]
                    results.append(data)
                else:
                    cb.failure(bank)
                    sources[bank] = "error"
            except Exception:
                cb.failure(bank)
                sources[bank] = "error"
    results.sort(key=lambda x: x.get("value", 0), reverse=True)
    return results, sources


# ═════════════════════════════════════════════════════════════════════════════
# API ENDPOINTS
# ═════════════════════════════════════════════════════════════════════════════

@router.get("/api/central-banks/list")
def list_banks():
    """List all supported central banks with metadata."""
    return {
        "banks": [
            {
                "id": bank_id,
                "name": info["name"],
                "country": info["country"],
                "flag": info["flag"],
                "api_type": info["api_type"],
                "auth_required": info["auth"] is not None,
                "categories": info["categories"],
                "note": info.get("note"),
            }
            for bank_id, info in BANKS.items()
        ],
        "total": len(BANKS),
        "no_key_required": sum(1 for b in BANKS.values() if b["auth"] is None),
    }


@router.get("/api/central-banks/rates")
def get_all_rates():
    """Compare policy rates across all central banks (concurrent fetch)."""
    cache = _load_cache()
    entry = cache.get("all_rates")
    if _is_fresh(entry, _DISK_TTL):
        return entry["data"]

    rates, sources = _fetch_all_rates()
    result = {
        "rates": rates,
        "count": len(rates),
        "as_of": datetime.utcnow().isoformat() + "Z",
        "_sources": sources,
    }
    cache["all_rates"] = {"ts": time.time(), "ttl": _DISK_TTL, "data": result}
    _save_cache(cache)
    return result


@router.get("/api/central-banks/{bank_id}/rate")
def get_bank_rate(bank_id: str):
    """Get policy rate for a specific central bank."""
    if bank_id not in BANKS:
        raise HTTPException(status_code=404, detail=f"Bank '{bank_id}' not found")
    if bank_id not in _RATE_FETCHERS:
        raise HTTPException(status_code=404, detail=f"No rate data for '{bank_id}'")

    if not cb.allow(bank_id):
        raise HTTPException(status_code=503, detail=f"Circuit breaker open for '{bank_id}' — try again later")

    cache_key = f"rate:{bank_id}"
    cache = _load_cache()
    entry = cache.get(cache_key)
    if _is_fresh(entry, _DISK_TTL):
        return entry["data"]

    fn = _RATE_FETCHERS[bank_id]
    data = fn()
    if not data:
        cb.failure(bank_id)
        raise HTTPException(status_code=503, detail=f"Could not fetch rate from {bank_id}")
    cb.success(bank_id)
    meta = BANKS[bank_id]
    data["flag"] = meta["flag"]
    data["country"] = meta["country"]
    data["bank_name"] = meta["name"]
    cache[cache_key] = {"ts": time.time(), "ttl": _DISK_TTL, "data": data}
    _save_cache(cache)
    return data


@router.get("/api/central-banks/{bank_id}/fx")
def get_bank_fx(bank_id: str, currency: str = Query(default="USD")):
    """Get exchange rate from a specific central bank."""
    if bank_id not in BANKS:
        raise HTTPException(status_code=404, detail=f"Bank '{bank_id}' not found")

    fx_map = {
        "ecb": _ecb_fx,
        "boc": _boc_fx,
        "norges": _norges_fx,
        "bundesbank": _bundesbank_fx,
        "snb": _snb_fx,
        "cbr": _cbr_fx,
    }
    fn = fx_map.get(bank_id)
    if not fn:
        raise HTTPException(status_code=404, detail=f"No FX data for '{bank_id}'")

    cache_key = f"fx:{bank_id}:{currency}"
    cache = _load_cache()
    entry = cache.get(cache_key)
    if _is_fresh(entry, _DISK_TTL):
        return entry["data"]

    data = fn(currency)
    if not data:
        raise HTTPException(status_code=503, detail=f"Could not fetch FX from {bank_id}")
    cache[cache_key] = {"ts": time.time(), "ttl": _DISK_TTL, "data": data}
    _save_cache(cache)
    return data


@router.get("/api/central-banks/ecb/hicp")
def get_ecb_hicp():
    """ECB Harmonised Index of Consumer Prices (Euro Area)."""
    cache = _load_cache()
    entry = cache.get("ecb:hicp")
    if _is_fresh(entry, _DISK_TTL):
        return entry["data"]
    data = _ecb_hicp()
    if not data:
        raise HTTPException(status_code=503, detail="Could not fetch HICP from ECB")
    cache["ecb:hicp"] = {"ts": time.time(), "ttl": _DISK_TTL, "data": data}
    _save_cache(cache)
    return data


@router.get("/api/central-banks/ecb/yield-curve")
def get_ecb_yield_curve():
    """Euro Area government bond yield curve."""
    cache = _load_cache()
    entry = cache.get("ecb:yc")
    if _is_fresh(entry, _DISK_TTL):
        return entry["data"]
    data = _ecb_yield_curve()
    if not data:
        raise HTTPException(status_code=503, detail="Could not fetch yield curve from ECB")
    cache["ecb:yc"] = {"ts": time.time(), "ttl": _DISK_TTL, "data": data}
    _save_cache(cache)
    return data


@router.get("/api/central-banks/bundesbank/inflation")
def get_bundesbank_inflation():
    """Germany CPI from Bundesbank."""
    cache = _load_cache()
    entry = cache.get("bbk:cpi")
    if _is_fresh(entry, _DISK_TTL):
        return entry["data"]
    data = _bundesbank_inflation()
    if not data:
        raise HTTPException(status_code=503, detail="Could not fetch inflation from Bundesbank")
    cache["bbk:cpi"] = {"ts": time.time(), "ttl": _DISK_TTL, "data": data}
    _save_cache(cache)
    return data


@router.get("/api/central-banks/eurostat/energy-prices")
def get_eurostat_energy_prices():
    """EU household electricity prices from Eurostat."""
    cache = _load_cache()
    entry = cache.get("eurostat:elec")
    if _is_fresh(entry, _DISK_TTL_SLOW):
        return entry["data"]
    data = _eurostat_energy_prices()
    if not data:
        raise HTTPException(status_code=503, detail="Could not fetch energy prices from Eurostat")
    cache["eurostat:elec"] = {"ts": time.time(), "ttl": _DISK_TTL_SLOW, "data": data}
    _save_cache(cache)
    return data


@router.get("/api/central-banks/eurostat/renewables")
def get_eurostat_renewables():
    """EU renewable energy share from Eurostat."""
    cache = _load_cache()
    entry = cache.get("eurostat:renew")
    if _is_fresh(entry, _DISK_TTL_SLOW):
        return entry["data"]
    data = _eurostat_renewables()
    if not data:
        raise HTTPException(status_code=503, detail="Could not fetch renewables from Eurostat")
    cache["eurostat:renew"] = {"ts": time.time(), "ttl": _DISK_TTL_SLOW, "data": data}
    _save_cache(cache)
    return data


@router.delete("/api/central-banks/cache")
def clear_cb_cache():
    """Reset central banks cache and circuit breaker."""
    _cb_mem.clear()
    cb.reset_all()
    try:
        cache = _load_cache()
        for entry in cache.values():
            if isinstance(entry, dict):
                entry["ts"] = 0
        _save_cache(cache)
    except Exception:
        pass
    return {"cleared": True, "circuit_breaker_reset": True}
