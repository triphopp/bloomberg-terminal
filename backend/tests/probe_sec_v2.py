"""
SEC Thailand v2 API path discovery script.
Run AFTER filling SEC2_* keys in backend/.env

Usage:
  python tests/probe_sec_v2.py               # probe all products
  python tests/probe_sec_v2.py --product bond
  python tests/probe_sec_v2.py --show-all    # show 404s too (verbose)
"""
import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

import requests

BASE = os.getenv("SEC_BASE_URL", "https://api.sec.or.th")

# Single key (Option A) or per-product (Option B) — uses whichever is set.
_SINGLE = os.getenv("SEC2_API_KEY", "")

def _key(product_env: str) -> str:
    """Per-product key takes priority; fall back to single key."""
    return os.getenv(product_env, "") or _SINGLE

KEYS = {
    "fund":          _key("SEC2_FUND_PRIMARY"),
    "bond":          _key("SEC2_BOND_PRIMARY"),
    "digital_asset": _key("SEC2_DIGITAL_ASSET_PRIMARY"),
    "one_report":    _key("SEC2_ONE_REPORT_PRIMARY"),
    "common":        _key("SEC2_COMMON_PRIMARY"),
}

_per_product_set = any(os.getenv(k) for k in [
    "SEC2_FUND_PRIMARY", "SEC2_BOND_PRIMARY",
    "SEC2_DIGITAL_ASSET_PRIMARY", "SEC2_ONE_REPORT_PRIMARY",
])
KEY_MODE = "per-product" if _per_product_set else ("single (SEC2_API_KEY)" if _SINGLE else "NONE SET")

# Candidate paths to probe per product — ordered from most likely to least likely.
# A 200 or non-404 (e.g. 400/422 = path exists but needs params) is a "hit".
PROBES: dict[str, list[str]] = {
    "fund": [
        # v2 with version segment
        "/FundFactsheet/v2/fund/amc",
        "/FundFactsheet/v2/amc",
        "/FundDailyInfo/v2/amc",
        "/FundDailyInfo/v2/fund/amc",
        # New product name
        "/Fund/v2/amc",
        "/Fund/v2/fund/amc",
        "/MutualFund/v2/amc",
        "/MutualFund/amc",
        # Flat v2
        "/v2/FundFactsheet/fund/amc",
        "/v2/FundDailyInfo/amc",
        "/v2/fund/amc",
        "/v2/MutualFund/amc",
        # Possible new resource names
        "/FundFactsheet/fund",
        "/FundFactsheet/amc",
        "/FundInfo/amc",
        "/FundInfo/v2/amc",
        "/fund-factsheet/v2/amc",
        "/fund-daily/v2/amc",
    ],
    "bond": [
        # v2 with version segment
        "/Debt/v2/debenture/company",
        "/Debt/v2/issuer",
        "/Debt/v2/company",
        "/Bond/v2/issuer",
        "/Bond/v2/company",
        "/Bond/v2/debenture",
        # Flat v2
        "/v2/Debt/issuer",
        "/v2/Debt/debenture",
        "/v2/Bond/issuer",
        "/v2/Bond/company",
        # New product name guesses
        "/DebtSecurity/v2/issuer",
        "/DebtSecurity/v2/company",
        "/DebtSecurity/issuer",
        "/DebtInstrument/v2/issuer",
        "/FixedIncome/v2/issuer",
        "/FixedIncome/issuer",
        "/Debenture/v2/company",
        "/Debenture/company",
        # Thai-derived names
        "/TarasanHni/issuer",
        "/BondMarket/v2/issuer",
        # Reference endpoints
        "/Debt/v2/ref/bond_type",
        "/Bond/v2/ref/bond_type",
        "/v2/Debt/ref",
    ],
    "digital_asset": [
        # v2 paths
        "/DigitalAsset/v2/operator",
        "/DigitalAsset/v2/exchange",
        "/DigitalAsset/v2/license",
        "/DigitalAsset/v2/company",
        "/DigitalAsset/v2/amc",
        "/v2/DigitalAsset/operator",
        "/v2/DigitalAsset/company",
        # New product name
        "/CryptoAsset/v2/operator",
        "/DA/v2/operator",
        "/DigitalAsset/operator",
        "/DigitalAsset/exchange",
        "/DigitalAsset/license",
        "/DigitalAsset/company",
        # Trade data
        "/DigitalAsset/v2/daily",
        "/DigitalAsset/v2/monthly",
    ],
    "one_report": [
        # v2 paths
        "/OneReport/v2/company",
        "/OneReport/v2/issuer",
        "/OneReport/v2/listed",
        "/v2/OneReport/company",
        "/v2/OneReport/issuer",
        # Possible renamed product
        "/AnnualReport/v2/company",
        "/AnnualReport/company",
        "/56One/v2/company",
        "/56One/company",
        "/CorporateReport/v2/company",
        "/DisclosureReport/v2/company",
        "/Disclosure/v2/company",
        "/Disclosure/company",
        # SEC uses "56-1 One Report" brand
        "/OneReport/company",
        "/OneReport/issuer",
        "/OneReport/listed",
        "/OneReport/section",
        "/OneReport/v2/section",
    ],
    "common": [
        # v2 of known-working legacy paths
        "/common/v2/ref/fund/portfolio/asset_type",
        "/v2/common/ref/fund/portfolio/asset_type",
        "/common/ref/v2/fund/portfolio/asset_type",
        # Other common ref endpoints
        "/common/v2/ref",
        "/common/ref/bond/bond_type",
        "/common/ref/da/asset_type",
        "/common/v2/ref/bond/bond_type",
        "/common/ref/one_report/section",
        "/common/v2/ref/investoralert/action_type",
    ],
}


def probe(product: str, show_all: bool) -> list[tuple[str, int]]:
    key = KEYS.get(product, "")
    if not key:
        print(f"  [SKIP] No key configured for {product} (set SEC2_{product.upper()}_PRIMARY)")
        return []

    headers = {"Ocp-Apim-Subscription-Key": key, "Accept": "application/json"}
    hits = []

    for path in PROBES.get(product, []):
        try:
            r = requests.get(f"{BASE}{path}", headers=headers, timeout=10)
            status = r.status_code
        except Exception as e:
            if show_all:
                print(f"  ERR  {path}  ({e})")
            continue

        is_hit = status != 404
        if is_hit or show_all:
            snippet = r.text[:100].encode("ascii", "replace").decode("ascii") if is_hit else ""
            label = "[HIT] " if is_hit else "[ 404]"
            print(f"  {label} {status}  {path}")
            if snippet:
                print(f"         {snippet}")
            hits.append((path, status))

        time.sleep(0.1)  # gentle rate limiting

    return hits


def main():
    parser = argparse.ArgumentParser(description="Discover SEC v2 API paths")
    parser.add_argument("--product", default="", help="Comma-separated products to probe")
    parser.add_argument("--show-all", action="store_true", help="Show 404s too")
    args = parser.parse_args()

    products = [p.strip() for p in args.product.split(",") if p.strip()] or list(PROBES)

    print("\n" + "=" * 62)
    print("  SEC Thailand v2 API Path Discovery")
    print("=" * 62)
    print(f"  Gateway  : {BASE}")
    print(f"  Key mode : {KEY_MODE}")
    if _SINGLE:
        print(f"  SEC2_API_KEY = SET (" + _SINGLE[:6] + "...)")
    print()
    print("  Effective key per product:")
    for prod, key in KEYS.items():
        if not products or prod in products:
            src = ""
            if os.getenv("SEC2_" + prod.upper() + "_PRIMARY"):
                src = " (per-product)"
            elif _SINGLE:
                src = " (from SEC2_API_KEY)"
            status = ("SET (" + key[:6] + "...)" + src) if key else "MISSING"
            print(f"    {prod:<16} {status}")

    all_hits: dict[str, list] = {}

    for product in products:
        print(f"\n{'-'*62}")
        print(f"  PROBING: {product.upper().replace('_', ' ')}  ({len(PROBES.get(product, []))} candidates)")
        print(f"{'-'*62}")
        hits = probe(product, args.show_all)
        all_hits[product] = hits

    print("\n" + "=" * 62)
    print("  SUMMARY — confirmed non-404 paths")
    print("=" * 62)
    total_hits = 0
    for product, hits in all_hits.items():
        if hits:
            print(f"\n  {product.upper().replace('_', ' ')}:")
            for path, status in hits:
                print(f"    {status}  {path}")
            total_hits += len(hits)
    if total_hits == 0:
        print("\n  No hits found. Check keys or try --show-all to see all responses.")
    print("=" * 62 + "\n")


if __name__ == "__main__":
    main()
