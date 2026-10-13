"""Which accounts a request is about.

Every portfolio endpoint takes an `account_id` that is one of three things:

    None / "" / "all"   the personal book: every account that belongs to no fund
    "fund:<fund id>"    one fund: every account whose fund_id is that fund
    anything else       that one account

Until 2026-10-13 "all" meant "no WHERE clause", so any account added to
`portfolio_accounts` was part of the personal book. A fund holds other people's
money and must never be summed into it (plans/fund-book.md, D5), so "all" is
now spelled out here and nowhere else: `tests/test_account_scope_rule.py`
fails on a hand-written `account_id != "all"`, and `tests/test_fund_isolation.py`
holds every personal figure still while a fund is added beside it.

The personal book is "not a fund account" rather than "one of the personal
accounts" on purpose: rows whose account was deleted or deactivated were part
of the unfiltered result before, and they still are.
"""
from __future__ import annotations

from typing import Callable, Optional

ALL = "all"
FUND_PREFIX = "fund:"
# Every book at once — only for code that then splits the rows by account
# itself (the NAV capture, a per-account summary). Never a request value.
EVERY = "*"

_FUND_IDS = "SELECT id FROM portfolio_accounts WHERE fund_id IS NOT NULL"


def is_all(scope: Optional[str]) -> bool:
    """The personal book (no account named)."""
    return not scope or scope == ALL


def fund_of(scope: Optional[str]) -> Optional[str]:
    """The fund id of a `fund:<id>` scope, else None."""
    if scope and scope.startswith(FUND_PREFIX):
        return scope[len(FUND_PREFIX):] or None
    return None


def account_of(scope: Optional[str]) -> Optional[str]:
    """The single account a scope names, else None (personal book or a fund)."""
    if is_all(scope) or fund_of(scope) or scope == EVERY:
        return None
    return scope


def book_of(conn, scope: Optional[str]) -> Optional[str]:
    """The book a scope sits in: None (personal) or `fund:<id>`. One account
    belongs to the book of its fund, or to the personal book."""
    if fund_of(scope):
        return scope
    one = account_of(scope)
    if one:
        row = conn.execute("SELECT fund_id FROM portfolio_accounts WHERE id = ?", (one,)).fetchone()
        if row and row[0]:
            return FUND_PREFIX + row[0]
    return None


def label(scope: Optional[str]) -> str:
    """The scope as a key for caches and snapshot rows: 'all', 'fund:<id>' or the account id."""
    return ALL if is_all(scope) else str(scope)


def where(scope: Optional[str], column: str = "account_id") -> tuple[str, list]:
    """SQL condition + params limiting `column` (an account id) to the scope.

    Always returns a condition — the personal book is a filter too."""
    if scope == EVERY:
        return "1 = 1", []
    fund = fund_of(scope)
    if fund:
        return f"{column} IN (SELECT id FROM portfolio_accounts WHERE fund_id = ?)", [fund]
    if is_all(scope):
        # IS NULL first: rows that name no account (audit events, journal
        # notes) were part of the unfiltered result and NOT IN drops NULLs.
        return f"({column} IS NULL OR {column} NOT IN ({_FUND_IDS}))", []
    return f"{column} = ?", [scope]


def accounts_where(scope: Optional[str], column: str = "id", fund_column: str = "fund_id") -> tuple[str, list]:
    """The same scope as a condition on `portfolio_accounts` itself."""
    fund = fund_of(scope)
    if fund:
        return f"{fund_column} = ?", [fund]
    if is_all(scope):
        return f"{fund_column} IS NULL", []
    return f"{column} = ?", [scope]


def and_where(scope: Optional[str], column: str = "account_id") -> tuple[str, list]:
    """`where` with a leading ' AND ', for SQL built by concatenation."""
    sql, params = where(scope, column)
    return f" AND {sql}", params


def fund_account_ids(conn) -> dict[str, str]:
    """{account id: fund id} of every account that belongs to a fund."""
    return {r[0]: r[1] for r in conn.execute(
        "SELECT id, fund_id FROM portfolio_accounts WHERE fund_id IS NOT NULL")}


def matcher(conn, scope: Optional[str]) -> Callable[[Optional[str]], bool]:
    """A test `account id -> in scope?` for rows already read into Python."""
    funds = fund_account_ids(conn)
    fund = fund_of(scope)
    if fund:
        return lambda account_id: funds.get(account_id) == fund
    if is_all(scope):
        return lambda account_id: account_id not in funds
    return lambda account_id: account_id == scope


def fund_scopes(conn) -> list[str]:
    """`fund:<id>` for every fund that has an account — what a background job
    walks after the personal book."""
    return [FUND_PREFIX + r[0] for r in conn.execute(
        "SELECT DISTINCT fund_id FROM portfolio_accounts WHERE fund_id IS NOT NULL ORDER BY fund_id")]
