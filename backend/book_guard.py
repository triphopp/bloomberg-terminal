"""A write lands in the book it was typed in.

plans/fund-book.md, D6: fund trades are entered from the FUND view only. The
personal ENTRY form never lists a fund account and the fund's never lists a
personal one, but a form holds a default account id before its list loads, and
a stale tab or a script can name any account. So every write that names an
account says which book it was made in, and the server compares:

    body["book"] absent / "all"   → the account must be a personal one
    body["book"] = "fund:<id>"    → the account must belong to that fund

A mismatch is 409 `wrong_book`. Money moved between a fund account and a
personal one in a single transfer is 409 `cross_book` whatever the book — the
two are never mixed (D1).

`book` rides in the JSON body because the Next.js proxies rebuild their
requests and forward bodies, not headers. Models ignore the extra field.
Attached as a router dependency; it reads the body Starlette has already
cached, so the endpoint parses it again at no cost.
"""
from __future__ import annotations

from fastapi import HTTPException, Request

import account_scope
from db import get_db

_ACCOUNT_KEYS = ("account_id", "from_account_id", "to_account_id")


def check(conn, body: dict) -> None:
    """Raise 409 when `body` names an account outside the book it claims."""
    named = [str(body[k]) for k in _ACCOUNT_KEYS if isinstance(body.get(k), str) and body.get(k)]
    if not named:
        return
    funds = account_scope.fund_account_ids(conn)
    books = {account_scope.FUND_PREFIX + funds[a] if a in funds else account_scope.ALL for a in named}
    if len(books) > 1:
        raise HTTPException(status_code=409, detail={
            "code": "cross_book",
            "detail": "A fund account and a personal account cannot be in one entry — the two books are never mixed."})
    actual = books.pop()
    claimed = body.get("book")
    claimed = account_scope.ALL if account_scope.is_all(claimed if isinstance(claimed, str) else None) else claimed
    if claimed != actual:
        where = "the FUND view" if actual != account_scope.ALL else "PORT"
        raise HTTPException(status_code=409, detail={
            "code": "wrong_book",
            "detail": f"Account {named[0]!r} belongs to {'a fund' if actual != account_scope.ALL else 'the personal book'}: "
                      f"enter this from {where}.",
            "account_book": actual, "entered_in": claimed})


async def book_guard(request: Request) -> None:
    if request.method not in ("POST", "PUT", "PATCH"):
        return
    if "application/json" not in (request.headers.get("content-type") or ""):
        return
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — not JSON: the endpoint will say so itself
        return
    if not isinstance(body, dict):
        return
    with get_db() as conn:
        check(conn, body)
