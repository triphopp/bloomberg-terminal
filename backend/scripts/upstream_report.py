"""
Summarise logs/upstream.jsonl — the data-source event log written by
backend/upstream_health.py. Meant for agents diagnosing "data missing / stale /
slow" reports: run this first, before reading router code.

    python backend/scripts/upstream_report.py              # last 6 hours
    python backend/scripts/upstream_report.py --hours 24
    python backend/scripts/upstream_report.py --source FRED --events fail retry
    python backend/scripts/upstream_report.py --raw        # matching lines as JSON

Reads the rotated `.1` file too. Contains no URLs or keys by construction.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

DEFAULT_LOG = Path(__file__).resolve().parents[2] / "logs" / "upstream.jsonl"


def load(path: Path, since: float) -> list[dict]:
    rows: list[dict] = []
    for p in (path.with_suffix(path.suffix + ".1"), path):
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("ts", 0) >= since:
                rows.append(e)
    rows.sort(key=lambda e: e["ts"])
    return rows


def report(rows: list[dict], hours: float) -> str:
    out: list[str] = []
    if not rows:
        return f"No upstream events in the last {hours:g}h — every data source answered (or the backend was not running)."

    fails = [e for e in rows if e["event"] == "fail"]
    retries = [e for e in rows if e["event"] == "retry"]
    status = [e for e in rows if e["event"] == "status"]
    network = [e for e in rows if e["event"] in ("network", "network_ok")]
    stale = [e for e in rows if e["event"] in ("stale", "fresh")]
    summaries = [e for e in rows if e["event"] == "summary"]

    out.append(f"Upstream report — last {hours:g}h · {rows[0]['time']} → {rows[-1]['time']}")
    out.append("")

    if network:
        out.append("NETWORK (DNS failing across sources = our connection, not a vendor)")
        for e in network:
            out.append(f"  {e['time']}  {e['event']:<10} {', '.join(e.get('sources') or [])}")
        out.append("")

    out.append("FINAL FAILURES by source × kind (after retries)")
    if fails:
        c = Counter((e["source"], e["kind"]) for e in fails)
        for (src, kind), n in c.most_common():
            out.append(f"  {n:5d}  {src:<14} {kind}")
    else:
        out.append("  none")
    out.append("")

    targets = Counter((e["source"], e.get("target")) for e in fails + retries if e.get("target"))
    if targets:
        out.append("TOP TARGETS (fail + retry) — a single target dominating = a dead/slow series, not an outage")
        for (src, tgt), n in targets.most_common(10):
            out.append(f"  {n:5d}  {src:<14} {tgt}")
        out.append("")

    if retries:
        c = Counter(e["source"] for e in retries)
        out.append("RETRIES (recovered or not) by source: " + ", ".join(f"{s} {n}" for s, n in c.most_common()))
        out.append("")

    if status:
        out.append("STATUS CHANGES")
        for e in status[-20:]:
            out.append(f"  {e['time']}  {e['source']:<14} {e['from']} → {e['to']}")
        out.append("")

    if stale:
        open_: dict[str, dict] = {}
        out.append("STALE DATA (served from an older successful pull)")
        for e in stale:
            if e["event"] == "stale":
                open_[e["key"]] = e
                out.append(f"  {e['time']}  START {e.get('label')} ({e.get('source')}) age {e.get('age_s')}s")
            else:
                out.append(f"  {e['time']}  END   {e['key']}")
                open_.pop(e["key"], None)
        if open_:
            out.append("  still stale: " + ", ".join(v.get("label", k) for k, v in open_.items()))
        out.append("")

    if summaries:
        tot: dict[str, Counter] = defaultdict(Counter)
        for e in summaries:
            for src, v in (e.get("sources") or {}).items():
                tot[src].update({k: v.get(k, 0) for k in ("calls", "fails", "retries")})
        minutes = max(1, len(summaries) * summaries[0].get("window_s", 600) / 60)
        out.append(f"VOLUME ({len(summaries)} ten-minute summaries)")
        out.append(f"  {'source':<14} {'calls/min':>9} {'fails':>6} {'retries':>8}")
        for src, c in sorted(tot.items(), key=lambda kv: -kv[1]["calls"]):
            out.append(f"  {src:<14} {c['calls'] / minutes:9.1f} {c['fails']:6d} {c['retries']:8d}")
        out.append("")

    return "\n".join(out).rstrip()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=float, default=6)
    ap.add_argument("--source", help="only this source (Yahoo, FRED, CBOE, …)")
    ap.add_argument("--events", nargs="*", help="only these event types")
    ap.add_argument("--raw", action="store_true", help="print matching events as JSON lines")
    ap.add_argument("--log", type=Path, default=DEFAULT_LOG)
    a = ap.parse_args(argv)

    rows = load(a.log, time.time() - a.hours * 3600)
    if a.source:
        rows = [e for e in rows if e.get("source") == a.source
                or a.source in (e.get("sources") or [])
                or a.source in (e.get("sources") or {})]
    if a.events:
        rows = [e for e in rows if e["event"] in a.events]
    if a.raw:
        for e in rows:
            print(json.dumps(e, ensure_ascii=False))
    else:
        print(report(rows, a.hours))
    return 0


if __name__ == "__main__":
    sys.exit(main())
