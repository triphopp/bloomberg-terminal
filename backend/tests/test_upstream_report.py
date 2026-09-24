"""upstream_report: the agent-facing summary of logs/upstream.jsonl."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import upstream_report as ur  # noqa: E402


def _write(path, events):
    path.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")


def test_report_names_the_dominant_target(tmp_path, capsys):
    now = time.time()
    ev = [{"ts": now - 60 * i, "time": "t", "event": "fail", "source": "FRED", "kind": "timeout",
           "target": "/graph/fredgraph.csv?id=DEAD"} for i in range(5)]
    ev.append({"ts": now, "time": "t", "event": "status", "source": "FRED", "from": "OK", "to": "DEGRADED"})
    log = tmp_path / "upstream.jsonl"
    _write(log, ev)
    ur.main(["--log", str(log), "--hours", "1"])
    out = capsys.readouterr().out
    assert "FRED" in out and "timeout" in out
    assert "/graph/fredgraph.csv?id=DEAD" in out
    assert "OK → DEGRADED" in out


def test_report_empty_and_filters(tmp_path, capsys):
    log = tmp_path / "upstream.jsonl"
    ur.main(["--log", str(log)])
    assert "No upstream events" in capsys.readouterr().out
    now = time.time()
    _write(log, [
        {"ts": now, "time": "t", "event": "fail", "source": "Yahoo", "kind": "rate_limit"},
        {"ts": now, "time": "t", "event": "fail", "source": "FRED", "kind": "timeout"},
        {"ts": now - 10 * 3600, "time": "old", "event": "fail", "source": "FRED", "kind": "dns"},
    ])
    ur.main(["--log", str(log), "--source", "FRED", "--raw"])
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["kind"] == "timeout"   # old one outside 6h
