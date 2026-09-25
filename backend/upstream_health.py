"""
Upstream health — what every outbound call to a data vendor just did.

On 2026-09-24 Yahoo throttled the whole IP (429) and the home connection lost
DNS, and the app said nothing: each panel went blank or printed its own
"NO DATA" with no hint that the cause was one vendor, or the network itself.
This module turns those failures into one answer — kept as a log for agents
to read (the in-app alert bar was removed 2026-09-24 at the user's request):

    OK        every source answered recently
    DEGRADED  a source failed within the window but is still answering
    DOWN      a source failed 3+ times in a row (429 / timeout / 5xx …)
    NETWORK   DNS failed for 2+ different sources — the problem is our
              connection, not a vendor

Feeding it: `install()` wraps `requests.Session.send` (FRED, CBOE, CNN, SEC,
Polymarket …) and `yahoo_gate` reports every yfinance request. Callers that
serve an older dataset because the fresh pull failed call `mark_stale()`.

Nothing here stores a URL: FRED keys ride in the query string. Incidents keep
the source name, the kind of failure and the target series only.

Event log — `logs/upstream.jsonl` (override: UPSTREAM_LOG), one JSON object
per line, rotated to `.1` at 5 MB. Events:

    fail     final failure after retries   source kind target elapsed_s
    retry    an attempt failed, retrying    source kind target elapsed_s attempt
    status   a source changed state         source from to
    network  DNS failing across sources     sources  (and network_ok when it clears)
    stale    serving an older dataset       key label source age_s
    fresh    stale dataset replaced         key
    summary  every 10 min, per source       sources: {name: {calls, fails, retries, status}}

Read it with `python backend/scripts/upstream_report.py` (see CLAUDE.md).
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import deque
from pathlib import Path
from dataclasses import dataclass, field
from urllib.parse import urlparse

#: A failure older than this no longer affects the status.
WINDOW_S = 600
#: Consecutive failures that make a source DOWN.
DOWN_AFTER = 3
#: Final failures (after retries) in the window before a source is DEGRADED.
#: One isolated failure is noise, not news.
DEGRADED_AFTER = 2
#: DNS failures from this many distinct sources within DNS_WINDOW_S = NETWORK.
NETWORK_SOURCES = 2
DNS_WINDOW_S = 180

#: hostname suffix → display name. Longest suffix wins.
SOURCES: dict[str, str] = {
    "finance.yahoo.com": "Yahoo",
    "yahoo.com": "Yahoo",
    "stlouisfed.org": "FRED",
    "cboe.com": "CBOE",
    "cnn.io": "CNN F&G",
    "sec.gov": "SEC",
    "fiscaldata.treasury.gov": "Treasury",
    "cftc.gov": "CFTC",
    "polymarket.com": "Polymarket",
    "alphavantage.co": "Alpha Vantage",
    "bot.or.th": "BOT",
    "mof.go.jp": "MOF Japan",
    "binance.com": "Binance",
    "worldbank.org": "World Bank",
}

#: Hosts that are not vendors — local services must never raise a data alert.
_LOCAL = ("localhost", "127.0.0.1", "::1")

KIND_LABEL = {
    "rate_limit": "ถูกจำกัด (429)",
    "dns": "resolve ชื่อไม่ได้ (DNS)",
    "timeout": "timeout",
    "connection": "เชื่อมต่อไม่ได้",
    "http_5xx": "เซิร์ฟเวอร์ปลายทางล่ม (5xx)",
    "http_4xx": "ถูกปฏิเสธ (4xx)",
    "empty": "ตอบกลับว่าง",
}


def source_of(url_or_host: str | None) -> str | None:
    if not url_or_host:
        return None
    host = urlparse(url_or_host).hostname if "://" in url_or_host else url_or_host
    host = (host or "").lower()
    if not host or host in _LOCAL:
        return None
    best = None
    for suffix, name in SOURCES.items():
        if (host == suffix or host.endswith("." + suffix)) and (best is None or len(suffix) > len(best[0])):
            best = (suffix, name)
    return best[1] if best else host


def classify_exception(exc: BaseException) -> str:
    """Kind of failure from an exception, by name and message — the concrete
    classes differ between requests, urllib3, curl_cffi and yfinance."""
    name = type(exc).__name__.lower()
    msg = str(exc).lower()
    if "ratelimit" in name or "429" in msg or "too many requests" in msg:
        return "rate_limit"
    if ("nameresolution" in name or "getaddrinfo" in msg or "failed to resolve" in msg
            or "could not resolve host" in msg or "name or service not known" in msg):
        return "dns"
    if "timeout" in name or "timed out" in msg:
        return "timeout"
    return "connection"


def classify_status(code: int | None) -> str | None:
    """None for success."""
    if code is None or code < 400:
        return None
    if code == 429:
        return "rate_limit"
    if code >= 500:
        return "http_5xx"
    # 404 on a data vendor usually means "no such series/symbol" — a data
    # answer, not an outage. Only auth-style rejections count.
    if code in (401, 403):
        return "http_4xx"
    return None


@dataclass
class _Source:
    name: str
    last_ok: float | None = None
    last_fail: float | None = None
    last_kind: str | None = None
    consecutive: int = 0
    fails: deque = field(default_factory=lambda: deque(maxlen=200))  # (ts, kind)
    calls: deque = field(default_factory=lambda: deque(maxlen=2000))  # ts
    retries: deque = field(default_factory=lambda: deque(maxlen=500))  # ts
    retry_log: deque = field(default_factory=lambda: deque(maxlen=20))
    status: str = "OK"


LOG_PATH = Path(os.getenv("UPSTREAM_LOG") or
                (Path(__file__).resolve().parent.parent / "logs" / "upstream.jsonl"))
LOG_MAX_BYTES = 5 * 1024 * 1024
SUMMARY_EVERY_S = 600

_log_lock = threading.Lock()
_last_summary = time.time()
_network_down = False


def _event(event: str, now: float | None = None, **fields) -> None:
    """Append one event to the JSONL log. Never raises — logging must not be
    able to break a data fetch."""
    now = time.time() if now is None else now
    rec = {"ts": round(now, 3),
           "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)),
           "event": event, **fields}
    try:
        line = json.dumps(rec, ensure_ascii=False, default=str) + "\n"
        with _log_lock:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
                LOG_PATH.replace(LOG_PATH.with_suffix(LOG_PATH.suffix + ".1"))
            with LOG_PATH.open("a", encoding="utf-8") as fh:
                fh.write(line)
    except Exception:
        pass


_lock = threading.Lock()
_sources: dict[str, _Source] = {}
_incidents: deque = deque(maxlen=50)
_stale: dict[str, dict] = {}


#: Query parameters that identify WHAT was asked for without revealing who
#: asked. Everything else — api_key above all — is dropped.
_TARGET_PARAMS = ("series_id", "release_id", "symbols", "s", "id")


def target_of(url: str | None) -> str | None:
    """'/fred/series/observations?series_id=DGS10' — path plus whitelisted
    identifying params. Never the key."""
    if not url:
        return None
    from urllib.parse import parse_qs

    u = urlparse(url)
    q = parse_qs(u.query)
    keep = [f"{k}={q[k][0]}" for k in _TARGET_PARAMS if k in q]
    return u.path + (("?" + "&".join(keep)) if keep else "")


def record(source: str | None, kind: str | None, now: float | None = None,
           target: str | None = None, elapsed: float | None = None) -> None:
    """One outbound call finished. `kind` None = success. `target`/`elapsed`
    go on the incident so a failure says which series and how long it hung."""
    if not source:
        return
    now = time.time() if now is None else now
    try:
        _record(source, kind, now, target, elapsed)
    finally:
        _after_record(now)


def _record(source, kind, now, target, elapsed) -> None:
    with _lock:
        s = _sources.setdefault(source, _Source(source))
        s.calls.append(now)
        if kind is None:
            s.last_ok = now
            s.consecutive = 0
            _transition(s, now)
            return
        s.last_fail = now
        s.last_kind = kind
        s.consecutive += 1
        s.fails.append((now, kind))
        # One incident per (source, kind) burst, not one per request.
        last = _incidents[-1] if _incidents else None
        if not (last and last["source"] == source and last["kind"] == kind and now - last["ts"] < 60):
            _incidents.append({"ts": now, "source": source, "kind": kind,
                               "targets": [target] if target else [],
                               "elapsed_s": None if elapsed is None else round(elapsed, 1)})
        else:
            last["count"] = last.get("count", 1) + 1
            if target and target not in last.setdefault("targets", []) and len(last["targets"]) < 8:
                last["targets"].append(target)
            last["ts_last"] = now
        _transition(s, now)
    _event("fail", now, source=source, kind=kind, target=target,
           elapsed_s=None if elapsed is None else round(elapsed, 1))


def _transition(s: "_Source", now: float) -> None:
    """Log a status change. Caller holds _lock; _event takes its own lock."""
    new = _source_status(s, now)
    if new != s.status:
        _event("status", now, source=s.name, **{"from": s.status, "to": new})
        s.status = new


def _after_record(now: float) -> None:
    """Network-wide state and the periodic summary — outside _lock."""
    global _network_down, _last_summary
    snap = None
    with _lock:
        dns = {s.name for s in _sources.values()
               for t, k in s.fails if k == "dns" and now - t <= DNS_WINDOW_S}
        down = len(dns) >= NETWORK_SOURCES
        changed = down != _network_down
        _network_down = down
        due = now - _last_summary >= SUMMARY_EVERY_S
        if due:
            _last_summary = now
            snap = {
                s.name: {
                    "calls": sum(1 for t in s.calls if now - t <= SUMMARY_EVERY_S),
                    "fails": sum(1 for t, _ in s.fails if now - t <= SUMMARY_EVERY_S),
                    "retries": sum(1 for t in s.retries if now - t <= SUMMARY_EVERY_S),
                    "status": _source_status(s, now),
                }
                for s in _sources.values()
            }
    if changed:
        _event("network" if down else "network_ok", now, sources=sorted(dns))
    if snap is not None:
        _event("summary", now, window_s=SUMMARY_EVERY_S, sources=snap)


def mark_stale(key: str, label: str, age_s: float, source: str | None = None) -> None:
    """A caller is serving an older dataset because the fresh pull failed."""
    with _lock:
        first = key not in _stale
        _stale[key] = {"key": key, "label": label, "age_s": age_s, "source": source, "since": time.time()}
    if first:
        _event("stale", key=key, label=label, source=source, age_s=round(age_s))


def clear_stale(key: str) -> None:
    with _lock:
        had = _stale.pop(key, None) is not None
    if had:
        _event("fresh", key=key)


def _source_status(s: _Source, now: float) -> str:
    recent = [k for t, k in s.fails if now - t <= WINDOW_S]
    if not recent:
        return "OK"
    if s.consecutive >= DOWN_AFTER and s.last_fail and now - s.last_fail <= WINDOW_S:
        return "DOWN"
    return "DEGRADED" if len(recent) >= DEGRADED_AFTER else "OK"


def snapshot(now: float | None = None) -> dict:
    now = time.time() if now is None else now
    with _lock:
        sources = []
        dns_sources = set()
        for s in _sources.values():
            status = _source_status(s, now)
            recent = [(t, k) for t, k in s.fails if now - t <= WINDOW_S]
            for t, k in recent:
                if k == "dns" and now - t <= DNS_WINDOW_S:
                    dns_sources.add(s.name)
            kinds: dict[str, int] = {}
            for _, k in recent:
                kinds[k] = kinds.get(k, 0) + 1
            sources.append({
                "source": s.name,
                "status": status,
                "last_kind": s.last_kind if recent else None,
                "last_kind_label": KIND_LABEL.get(s.last_kind or "", s.last_kind) if recent else None,
                "consecutive_failures": s.consecutive,
                "failures_window": len(recent),
                "failure_kinds": kinds,
                "calls_per_min": sum(1 for t in s.calls if now - t <= 60),
                "retries_window": sum(1 for t in s.retries if now - t <= WINDOW_S),
                "recent_retries": [
                    {**r, "ago_s": round(now - r["ts"])} for r in list(s.retry_log)[-8:]
                    if now - r["ts"] <= 3600
                ][::-1],
                "last_ok_ago_s": None if s.last_ok is None else round(now - s.last_ok),
                "last_fail_ago_s": None if s.last_fail is None else round(now - s.last_fail),
            })
        incidents = [
            {**i, "ago_s": round(now - i.get("ts_last", i["ts"])),
             "kind_label": KIND_LABEL.get(i["kind"], i["kind"])}
            for i in list(_incidents)[-15:]
            if now - i.get("ts_last", i["ts"]) <= 3600
        ][::-1]
        stale = [
            {**v, "age_s": round(v["age_s"] + (now - v["since"]))}
            for v in _stale.values()
        ]

    rank = {"OK": 0, "DEGRADED": 1, "DOWN": 2}
    worst = max((rank[s["status"]] for s in sources), default=0)
    overall = ("NETWORK" if len(dns_sources) >= NETWORK_SOURCES
               else {0: "OK", 1: "DEGRADED", 2: "DOWN"}[worst])
    sources.sort(key=lambda s: (-rank[s["status"]], s["source"]))
    return {
        "overall": overall,
        "dns_failed_sources": sorted(dns_sources),
        "sources": sources,
        "incidents": incidents,
        "stale": sorted(stale, key=lambda v: -v["age_s"]),
        "window_s": WINDOW_S,
        "ts": now,
    }


def reset() -> None:
    """Tests only."""
    global _network_down, _last_summary
    _network_down = False
    _last_summary = time.time()
    with _lock:
        _sources.clear()
        _incidents.clear()
        _stale.clear()


# ─── requests hook: observe, cap, retry, redact ───────────────────────────────
# FRED timed out in bursts: rates (11 tenors on 6 threads), crisis (8), macro
# (4), the release calendar (4) and TAIL all hit it at startup, 20+ requests at
# once, and FRED answered with 15s read timeouts and the odd 502 — then served
# the very next request fine. One slow reply became a failure, and a failure
# became a yellow alert. Now: per-source concurrency cap, bounded retry for
# idempotent GETs, and only the FINAL outcome is recorded.

#: Max in-flight requests per source, process-wide. Sources not listed are
#: unbounded (they are low-volume).
SOURCE_LIMITS: dict[str, int] = {"FRED": 3}

#: Per-source retry plan for GETs: sleeps before attempt 2, 3, …
RETRY_BACKOFF: dict[str, tuple[float, ...]] = {"FRED": (1.0, 3.0)}

#: Failure kinds worth a retry. DNS is not: the network is down, and hammering
#: it from every thread is what made the 2026-09-24 outage worse.
RETRYABLE = {"timeout", "connection", "http_5xx", "rate_limit"}

_source_sems: dict[str, threading.BoundedSemaphore] = {
    k: threading.BoundedSemaphore(v) for k, v in SOURCE_LIMITS.items()
}

import re  # noqa: E402

_SECRET_RE = re.compile(r"((?:api_key|apikey|token|access_token|key)=)[^&\s'\")]+", re.I)


def redact(text: str) -> str:
    """Strip credentials from a URL or message. FRED puts `api_key` in the
    query string, and every requests error message quotes the full URL — it
    was landing in logs/backend.log in plain text."""
    return _SECRET_RE.sub(r"\1***", text)


def _redact_exc(exc: BaseException) -> None:
    try:
        exc.args = tuple(redact(str(a)) for a in exc.args)
    except Exception:  # pragma: no cover - exotic exception types
        pass


class _Null:
    def __enter__(self):
        return None

    def __exit__(self, *a):
        return False


_NULL = _Null()


#: Stop retrying a source once it has failed this many times in a row …
FAIL_FAST_AFTER = DOWN_AFTER
#: … and the last failure is this recent.
FAIL_FAST_WINDOW_S = 60


def _failing_fast(source: str | None) -> bool:
    if not source:
        return False
    with _lock:
        s = _sources.get(source)
        return bool(s and s.consecutive >= FAIL_FAST_AFTER and s.last_fail
                    and time.time() - s.last_fail <= FAIL_FAST_WINDOW_S)


def _note_retry(source: str | None, target: str | None = None, kind: str | None = None,
                elapsed: float | None = None) -> None:
    if not source:
        return
    with _lock:
        s = _sources.setdefault(source, _Source(source))
        s.retries.append(time.time())
        s.retry_log.append({"ts": time.time(), "target": target, "kind": kind,
                            "elapsed_s": None if elapsed is None else round(elapsed, 1)})
    _event("retry", source=source, kind=kind, target=target,
           elapsed_s=None if elapsed is None else round(elapsed, 1))


def install() -> bool:
    """Wrap every `requests` call (FRED, CBOE, CNN, SEC …). Idempotent.

    Behaviour it adds: per-source concurrency cap, bounded retry for GETs on
    listed sources, credential scrubbing in error text and `response.url`.
    Callers still get exactly one response or one exception."""
    try:
        import requests
    except Exception:  # pragma: no cover
        return False
    orig = requests.Session.send
    if getattr(orig, "_upstream_observed", False):
        return True

    def send(self, request, **kwargs):
        src = source_of(getattr(request, "url", None))
        backoff = RETRY_BACKOFF.get(src, ()) if getattr(request, "method", "GET") == "GET" else ()
        if backoff and _failing_fast(src):
            # Source is already down: retries would only multiply the wait
            # (3 x 15s per request, 3 at a time) and keep the pressure on.
            backoff = ()
        sem = _source_sems.get(src, _NULL)
        tgt = target_of(getattr(request, "url", None))
        t_start = time.time()
        for attempt in range(len(backoff) + 1):
            last = attempt == len(backoff)
            try:
                with sem:
                    resp = orig(self, request, **kwargs)
            except Exception as exc:
                kind = classify_exception(exc)
                if not last and kind in RETRYABLE:
                    _note_retry(src, tgt, kind, time.time() - t_start)
                    time.sleep(backoff[attempt])
                    continue
                record(src, kind, target=tgt, elapsed=time.time() - t_start)
                _redact_exc(exc)
                raise
            kind = classify_status(getattr(resp, "status_code", None))
            if kind in RETRYABLE and not last:
                _note_retry(src, tgt, kind, time.time() - t_start)
                resp.close()
                time.sleep(backoff[attempt])
                continue
            record(src, kind, target=tgt if kind else None, elapsed=time.time() - t_start if kind else None)
            try:
                resp.url = redact(resp.url)  # raise_for_status() quotes it
            except Exception:  # pragma: no cover
                pass
            return resp
        raise RuntimeError("unreachable")  # pragma: no cover

    send._upstream_observed = True  # type: ignore[attr-defined]
    send.__wrapped__ = orig  # type: ignore[attr-defined]
    requests.Session.send = send
    return True


INSTALLED = install()
