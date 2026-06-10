"""
SEC Thailand API -- integration test script.
Tests confirmed-working endpoints only.

Usage:
  python tests/test_sec_api.py              # all working products
  python tests/test_sec_api.py --dry-run    # print URLs without calling
  python tests/test_sec_api.py --product fund_factsheet
"""
import argparse
import json
import os
import sys
import time
import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

import requests

SEC_BASE_URL = os.getenv("SEC_BASE_URL", "https://api.sec.or.th")
SEC_KEYS = {
    "common":         os.getenv("SEC_COMMON_PRIMARY", ""),
    "bond":           os.getenv("SEC_BOND_PRIMARY", ""),
    "fund_factsheet": os.getenv("SEC_FUND_FACTSHEET_PRIMARY", ""),
    "fund_daily":     os.getenv("SEC_FUND_DAILY_PRIMARY", ""),
    "digital_asset":  os.getenv("SEC_DIGITAL_ASSET_PRIMARY", ""),
    "one_report":     os.getenv("SEC_ONE_REPORT_PRIMARY", ""),
}

yesterday = (datetime.date.today() - datetime.timedelta(days=1)).strftime("%Y-%m-%d")

# Only confirmed-working endpoints
TESTS = {
    "common": [
        ("Asset type reference",  "GET", "/common/ref/fund/portfolio/asset_type",  {}),
        ("Alert action types",    "GET", "/common/ref/investoralert/action_type",   {}),
    ],
    "fund_factsheet": [
        ("AMC list",              "GET", "/FundFactsheet/fund/amc",                {}),
        ("KAsset funds",          "GET", "/FundFactsheet/fund/amc/C0000000021",    {}),
        ("Fund suitability",      "GET", "/FundFactsheet/fund/M0000_2553/suitability", {}),
        ("Fund performance",      "GET", "/FundFactsheet/fund/M0000_2553/performance", {}),
        ("Fund fee",              "GET", "/FundFactsheet/fund/M0000_2553/fee",     {}),
        ("Fund policy",           "GET", "/FundFactsheet/fund/M0000_2553/policy",  {}),
    ],
    "fund_daily": [
        ("AMC list (daily)",      "GET", "/FundDailyInfo/amc",                     {}),
        ("NAV yesterday",         "GET", f"/FundDailyInfo/M0000_2553/dailynav/{yesterday}", {}),
    ],
}

NOT_TESTED = {
    "bond":          "requires new portal (secopendata.sec.or.th)",
    "digital_asset": "under maintenance by SEC",
    "one_report":    "requires new portal (secopendata.sec.or.th)",
}


def _call(product, method, path, params):
    api_key = SEC_KEYS.get(product, "")
    if not api_key:
        return 0, "NO KEY", 0.0

    t0 = time.time()
    try:
        r = requests.request(
            method, f"{SEC_BASE_URL}{path}",
            params=params if method == "GET" else None,
            headers={"Ocp-Apim-Subscription-Key": api_key, "Accept": "application/json"},
            timeout=15,
        )
        elapsed = time.time() - t0
        if r.status_code in (200, 204):
            try:
                snippet = json.dumps(r.json(), ensure_ascii=False)[:200] if r.status_code == 200 else "(no content)"
            except Exception:
                snippet = r.text[:200]
            return r.status_code, snippet, elapsed
        return r.status_code, r.text[:200], elapsed
    except Exception as e:
        return 0, str(e)[:200], time.time() - t0


def run_tests(products, dry_run):
    results = {"pass": 0, "fail": 0, "skip": 0}

    for product, cases in TESTS.items():
        if products and product not in products:
            continue

        api_key = SEC_KEYS.get(product, "")
        key_str = ("SET (" + api_key[:6] + "...)") if api_key else "missing"
        print(f"\n{'-'*62}")
        print(f"  {product.upper().replace('_', ' ')}")
        print(f"  Key: {key_str}")
        print(f"{'-'*62}")

        for label, method, path, params in cases:
            if dry_run:
                print(f"  [DRY] {method} {SEC_BASE_URL}{path}")
                results["skip"] += 1
                continue

            status, snippet, elapsed = _call(product, method, path, params)
            ok = status in (200, 204)
            icon = "[OK]  " if ok else "[FAIL]"
            print(f"  {icon} {label}  (HTTP {status}, {elapsed:.2f}s)")
            if snippet and snippet != "(no content)":
                safe = snippet[:180].encode("ascii", errors="replace").decode("ascii")
                print(f"        {safe}")
            results["pass" if ok else "fail"] += 1

    # Show not-tested products
    print(f"\n{'-'*62}")
    print("  PRODUCTS NOT TESTED")
    print(f"{'-'*62}")
    for product, reason in NOT_TESTED.items():
        if not products or product in products:
            key = SEC_KEYS.get(product, "")
            key_str = ("SET (" + key[:6] + "...)") if key else "missing"
            print(f"  [SKIP] {product.upper().replace('_', ' ')}  -- {reason}  (key: {key_str})")

    return results


def main():
    parser = argparse.ArgumentParser(description="Test SEC Thailand Open API")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--product", type=str, default="",
                        help="Comma-separated: " + ", ".join(list(TESTS) + list(NOT_TESTED)))
    args = parser.parse_args()

    products = [p.strip() for p in args.product.split(",") if p.strip()]

    print("\n" + "=" * 62)
    print("  SEC Thailand Open API - Integration Test")
    print("=" * 62)
    print(f"  Base URL : {SEC_BASE_URL}")
    print(f"  Mode     : {'DRY-RUN' if args.dry_run else 'LIVE'}")
    print(f"  Auth     : Ocp-Apim-Subscription-Key header")
    print()
    print("  Key configuration:")
    for prod, key in SEC_KEYS.items():
        status = ("SET (" + key[:6] + "...)") if key else "missing"
        print(f"    {prod:<18} {status}")

    results = run_tests(products, args.dry_run)

    print("\n" + "=" * 62)
    if args.dry_run:
        print(f"  Dry-run: {results['skip']} endpoints listed")
    else:
        total = results["pass"] + results["fail"]
        print(f"  Results: {results['pass']}/{total} passed  |  {results['fail']} failed")
    print("=" * 62 + "\n")

    if results["fail"] > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
