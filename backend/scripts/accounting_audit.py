"""Read-only accounting audit. Exit 1 on errors, 2 on invalid arguments.

    python scripts/accounting_audit.py --json
    python scripts/accounting_audit.py --db backups/book.db --account dime
    python scripts/accounting_audit.py --api-url http://localhost:9317 --json report.json

Endpoint comparison is opt-in: it calls only local portfolio GET endpoints.
Without it C1 is explicitly skipped, never reported as passed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from urllib.parse import urlencode, urlsplit
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from accounting_io import read_book
import accounting_checks
from config import DB_PATH


def collect_endpoints(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("--api-url must be a local backend")
    def get(route, **params):
        with urlopen(url.rstrip("/") + "/api/v2/portfolio/" + route + "?" + urlencode(params), timeout=45) as r:
            return json.load(r)
    summary = get("summary", base_currency="THB")
    returns = get("returns", base_currency="THB")
    aids = [r["account"]["id"] for r in summary["accounts"]] + ["all"]
    return {"captured_at": datetime.now(timezone.utc).isoformat(), "summary": summary,
            "returns": returns, "histories": {a: get("nav-history", account_id=a, days=1) for a in aids}}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--account")
    ap.add_argument("--codes", help="Comma-separated check families, e.g. H1,H2,H3")
    ap.add_argument("--json", nargs="?", const="-", help="Print JSON, or write it to a file")
    live = ap.add_mutually_exclusive_group()
    live.add_argument("--api-url")
    live.add_argument("--endpoint-samples", help="JSON captured from summary, returns and histories")
    ap.add_argument("--nav-validation", help="JSON list of account_id, date, rebuilt, live samples")
    args = ap.parse_args(argv)
    try:
        samples = collect_endpoints(args.api_url) if args.api_url else (json.loads(Path(args.endpoint_samples).read_text(encoding="utf-8")) if args.endpoint_samples else None)
        validation = json.loads(Path(args.nav_validation).read_text(encoding="utf-8")) if args.nav_validation else None
        with read_book(args.db) as conn:
            report = accounting_checks.run(conn, account_id=args.account,
                codes=[c.strip() for c in args.codes.split(",")] if args.codes else None,
                endpoint_samples=samples, nav_validation=validation)
        payload = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False)
        if args.json == "-":
            print(payload)
        elif args.json:
            Path(args.json).write_text(payload, encoding="utf-8")
            print(json.dumps({"report": args.json, "counts": report["counts"]}))
        else:
            print(f"Reconstructed book: {report['events']} events; posted: {report['posted_events']}")
            for row in report["checks"]:
                print(f"{row['code']:3} {row['status']:8} {row['evaluated']:4}  {row.get('reason', '')}")
            for f in report["findings"]:
                print(f"{f['severity'].upper():5} {f['code']:25} {f['account_id'] or '-':12} {f['symbol'] or '-':10} {f['message']}")
            print(json.dumps(report["counts"]))
        return 1 if report["counts"]["error"] else 0
    except (ValueError, KeyError, OSError) as exc:
        print(f"Audit failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
