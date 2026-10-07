"""
Risk decision journal — why a rule was not followed, followed, or changed.

One row per decision in `risk_decisions`, written by:
    TRADE GUARD HOLD            kind STOP       decision HOLD    (routers/risk.py, mirrors guard_overrides)
    a stop-loss level edited    kind STOP       decision CHANGE  (routers/portfolio_v2.py patch_trade)
    REBALANCE "not yet"         kind REBALANCE  decision HOLD    (POST /risk/decisions)
    anything typed by hand      any kind        FOLLOW / CHANGE / NOTE

`snapshot` holds the numbers on screen at that moment (price, stop, weight,
target, …) so the reason can be read against what was known then.

Rows are never edited. A REBALANCE HOLD is live until `review_on` passes or it
is ended (`cleared_at`); while live, the holding leaves the TRIM list and the
weekly guard:REBALANCE alert stays quiet (rebalance.apply_holds).

Machine-local: `risk_decisions` is NOT in sync SYNC_TABLES — a peer on older
code drops ops for a table it does not know. Add it there only once every
machine runs this code.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from typing import Any, Optional

KINDS = ("STOP", "REBALANCE", "BUDGET", "OTHER")
DECISIONS = ("HOLD", "FOLLOW", "CHANGE", "NOTE")
DEFAULT_REVIEW_DAYS = 14
NO_REASON = "ไม่ระบุเหตุผล"


def record(
    conn,
    *,
    kind: str,
    decision: str,
    reason: str,
    account_id: Optional[str] = None,
    symbol: Optional[str] = None,
    yf_symbol: Optional[str] = None,
    snapshot: Optional[dict] = None,
    review_on: Optional[str] = None,
    ref_id: Optional[str] = None,
    source: str = "user",
) -> str:
    """Insert one decision. Raises ValueError on a bad kind / decision or an
    empty reason — the journal exists for the reason."""
    kind, decision = kind.upper(), decision.upper()
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    if decision not in DECISIONS:
        raise ValueError(f"decision must be one of {DECISIONS}")
    reason = (reason or "").strip()
    if not reason:
        raise ValueError("reason required")
    did = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO risk_decisions (id, kind, decision, account_id, symbol, yf_symbol, reason, "
        "snapshot, review_on, ref_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (did, kind, decision, account_id or None, (symbol or "").upper() or None,
         (yf_symbol or "").upper() or None, reason[:1000],
         json.dumps({k: v for k, v in (snapshot or {}).items() if v is not None}, ensure_ascii=False),
         review_on, ref_id, source, datetime.now().isoformat(timespec="seconds")),
    )
    return did


def review_date(days: Optional[int], today: Optional[date] = None) -> str:
    d = DEFAULT_REVIEW_DAYS if days is None else int(days)
    if not 1 <= d <= 365:
        raise ValueError("review_days must be 1–365")
    return ((today or date.today()) + timedelta(days=d)).isoformat()


def _row(r) -> dict[str, Any]:
    d = dict(r)
    try:
        d["snapshot"] = json.loads(d.get("snapshot") or "{}")
    except ValueError:
        d["snapshot"] = {}
    return d


def rebalance_holds(conn) -> dict[str, dict]:
    """symbol → the newest REBALANCE HOLD not ended by hand. Expiry by
    `review_on` is judged by the caller (rebalance.apply_holds) so an expired
    hold can still be shown as "ended — decide again"."""
    out: dict[str, dict] = {}
    for r in conn.execute(
        "SELECT * FROM risk_decisions WHERE kind = 'REBALANCE' AND decision = 'HOLD' "
        "AND cleared_at IS NULL AND symbol IS NOT NULL ORDER BY created_at, rowid"
    ).fetchall():
        out[r["symbol"]] = _row(r)
    return out


def end_previous_holds(conn, kind: str, symbol: str) -> int:
    """A new HOLD replaces the live one for the same symbol (kept, marked ended)."""
    cur = conn.execute(
        "UPDATE risk_decisions SET cleared_at = ? WHERE kind = ? AND decision = 'HOLD' "
        "AND symbol = ? AND cleared_at IS NULL",
        (datetime.now().isoformat(timespec="seconds"), kind.upper(), symbol.upper()),
    )
    return cur.rowcount


def list_decisions(
    conn,
    account_id: Optional[str] = None,
    kind: Optional[str] = None,
    symbol: Optional[str] = None,
    limit: int = 200,
) -> list[dict]:
    clauses, params = [], []
    if account_id and account_id != "all":
        # Book-wide rows (no account) belong to every account's view.
        clauses.append("(account_id = ? OR account_id IS NULL OR account_id = 'all')")
        params.append(account_id)
    if kind:
        clauses.append("kind = ?")
        params.append(kind.upper())
    if symbol:
        clauses.append("symbol = ?")
        params.append(symbol.upper())
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM risk_decisions{where} ORDER BY created_at DESC, rowid DESC LIMIT ?",
        params + [max(1, min(int(limit), 1000))],
    ).fetchall()
    today = date.today().isoformat()
    out = []
    for r in rows:
        d = _row(r)
        d["active"] = bool(
            d["decision"] == "HOLD" and not d.get("cleared_at")
            and (not d.get("review_on") or d["review_on"] >= today))
        out.append(d)
    return out
