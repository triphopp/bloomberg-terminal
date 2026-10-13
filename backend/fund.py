"""Fund book — who put money into a pooled fund and what it bought of the fund.

plans/fund-book.md. The fund's holdings, cash and dividends are ordinary rows
under accounts whose `portfolio_accounts.fund_id` is the fund (scope
`fund:<id>`, backend/account_scope.py). This module holds what only a fund
has:

  * members;
  * deposits, each frozen with the unit price of the day it arrived — the
    fund's value per unit BEFORE the money came in — and the units it bought;
  * the rule results are shared by, as dated rows.

Two measures are kept on purpose (decision D2): CAPITAL, the money a member
put in, is what results are shared by (D3, no time weighting); UNITS are what
the money bought at that day's value — the fund's performance measure and the
comparison shown beside every capital figure. Nothing here pays by units.

Pure with respect to the market: valuing the fund is the caller's job
(routers/fund.py), so every function takes the NAV it needs as an argument.
Amounts are Decimal, stored as text.
"""
from __future__ import annotations

import uuid
from datetime import date as _date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Optional

import account_scope

MONEY = Decimal("0.01")
UNIT = Decimal("0.000001")
BASES = ("CAPITAL",)          # EQUAL and a manager's share are undecided (plan O5)
PRICE_SOURCES = ("par", "live", "snapshot", "manual")


class FundError(Exception):
    """A refusal the caller turns into an HTTP answer: `status`, `code`, `detail`."""

    def __init__(self, status: int, code: str, detail: str):
        super().__init__(detail)
        self.status, self.code, self.detail = status, code, detail


def dec(value, what: str = "number") -> Decimal:
    try:
        d = Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        raise FundError(422, "bad_number", f"{what} is not a number: {value!r}")
    if not d.is_finite():
        raise FundError(422, "bad_number", f"{what} is not a number: {value!r}")
    return d


def _q(d: Decimal, step: Decimal) -> Decimal:
    return d.quantize(step, rounding=ROUND_HALF_UP)


def _day(value: str, what: str = "date") -> str:
    try:
        return _date.fromisoformat(str(value)[:10]).isoformat()
    except (TypeError, ValueError):
        raise FundError(422, "bad_date", f"{what} must be YYYY-MM-DD: {value!r}")


def scope_of(fund_id: str) -> str:
    return account_scope.FUND_PREFIX + fund_id


# ── funds ────────────────────────────────────────────────────────────────────

def get_fund(conn, fund_id: str) -> dict:
    row = conn.execute("SELECT * FROM funds WHERE id = ?", (fund_id,)).fetchone()
    if row is None:
        raise FundError(404, "unknown_fund", f"No fund {fund_id!r}")
    return dict(row)


def list_funds(conn) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM funds ORDER BY created_at, name")]


def create_fund(conn, *, name: str, base_currency: str = "THB", unit_par="10",
                broker_note: str = "", agreement_ref: str = "", today: Optional[str] = None) -> dict:
    name = (name or "").strip()
    if not name:
        raise FundError(422, "name_required", "A fund needs a name")
    base = (base_currency or "").strip().upper()
    if base not in ("THB", "USD"):
        raise FundError(422, "bad_currency", "base_currency must be THB or USD")
    par = dec(unit_par, "unit_par")
    if par <= 0:
        raise FundError(422, "bad_par", "unit_par must be positive")
    if conn.execute("SELECT 1 FROM funds WHERE LOWER(name) = LOWER(?)", (name,)).fetchone():
        raise FundError(409, "name_taken", f"A fund named {name!r} already exists")
    fund_id = uuid.uuid4().hex[:12]
    conn.execute(
        "INSERT INTO funds (id, name, base_currency, unit_par, broker_note, agreement_ref) VALUES (?,?,?,?,?,?)",
        (fund_id, name, base, str(par), broker_note or "", agreement_ref or ""))
    # Decision D3: results are shared by capital. Written as the first dated
    # rule so a later change has something to supersede.
    conn.execute(
        "INSERT INTO fund_split_rules (id, fund_id, effective_from, basis, reason) VALUES (?,?,?,?,?)",
        (str(uuid.uuid4()), fund_id, today or _date.today().isoformat(), "CAPITAL", "set when the fund was created"))
    return get_fund(conn, fund_id)


def accounts(conn, fund_id: str) -> list[dict]:
    return [dict(r) for r in conn.execute(
        "SELECT * FROM portfolio_accounts WHERE fund_id = ? ORDER BY created_at, id", (fund_id,))]


def add_account(conn, fund_id: str, *, account_id: str, name: str, currency: str, broker: str = "",
                country: str = "TH", account_type: str = "equity") -> dict:
    """A broker account that belongs to the fund. Always a NEW account: an
    account that has ever been personal keeps its history in the personal book
    and may not be moved into a fund (decision D1 — nothing is mixed)."""
    get_fund(conn, fund_id)
    account_id = (account_id or "").strip()
    if not account_id or account_id == account_scope.ALL or account_id.startswith(account_scope.FUND_PREFIX) \
            or account_id == account_scope.EVERY:
        raise FundError(422, "bad_account_id", f"{account_id!r} cannot be an account id")
    if conn.execute("SELECT 1 FROM portfolio_accounts WHERE id = ?", (account_id,)).fetchone():
        raise FundError(409, "account_exists", f"Account {account_id!r} already exists — a fund account is always new")
    ccy = (currency or "").strip().upper()
    if ccy not in ("THB", "USD"):
        raise FundError(422, "bad_currency", "currency must be THB or USD")
    conn.execute(
        "INSERT INTO portfolio_accounts (id, name, broker, country, currency, account_type, fund_id) "
        "VALUES (?,?,?,?,?,?,?)",
        (account_id, (name or account_id).strip(), broker or "", country or "TH", ccy, account_type or "equity", fund_id))
    return dict(conn.execute("SELECT * FROM portfolio_accounts WHERE id = ?", (account_id,)).fetchone())


# ── split rule ───────────────────────────────────────────────────────────────

def split_rule(conn, fund_id: str, on: Optional[str] = None) -> Optional[dict]:
    """The rule in force on a day (today by default): the latest row dated on or before it."""
    day = _day(on) if on else _date.today().isoformat()
    row = conn.execute(
        "SELECT * FROM fund_split_rules WHERE fund_id = ? AND effective_from <= ? "
        "ORDER BY effective_from DESC, created_at DESC, rowid DESC LIMIT 1", (fund_id, day)).fetchone()
    return dict(row) if row else None


def set_split_rule(conn, fund_id: str, *, basis: str, effective_from: str, reason: str) -> dict:
    get_fund(conn, fund_id)
    b = (basis or "").strip().upper()
    if b not in BASES:
        raise FundError(422, "basis_undecided",
                        f"basis {basis!r} is not available: only {', '.join(BASES)} has been decided for this system")
    if not (reason or "").strip():
        raise FundError(422, "reason_required", "Changing how results are shared needs a reason")
    rule_id = str(uuid.uuid4())
    conn.execute("INSERT INTO fund_split_rules (id, fund_id, effective_from, basis, reason) VALUES (?,?,?,?,?)",
                 (rule_id, fund_id, _day(effective_from, "effective_from"), b, reason.strip()))
    return dict(conn.execute("SELECT * FROM fund_split_rules WHERE id = ?", (rule_id,)).fetchone())


# ── members ──────────────────────────────────────────────────────────────────

def add_member(conn, fund_id: str, *, name: str, contact: str = "", joined_on: Optional[str] = None,
               note: str = "") -> dict:
    get_fund(conn, fund_id)
    name = (name or "").strip()
    if not name:
        raise FundError(422, "name_required", "A member needs a name")
    if conn.execute("SELECT 1 FROM fund_members WHERE fund_id = ? AND LOWER(name) = LOWER(?)",
                    (fund_id, name)).fetchone():
        raise FundError(409, "member_exists", f"{name!r} is already a member of this fund")
    member_id = str(uuid.uuid4())
    conn.execute("INSERT INTO fund_members (id, fund_id, name, contact, joined_on, note) VALUES (?,?,?,?,?,?)",
                 (member_id, fund_id, name, contact or "", _day(joined_on, "joined_on") if joined_on else None, note or ""))
    return dict(conn.execute("SELECT * FROM fund_members WHERE id = ?", (member_id,)).fetchone())


def _member(conn, fund_id: str, member_id: str) -> dict:
    row = conn.execute("SELECT * FROM fund_members WHERE id = ? AND fund_id = ?", (member_id, fund_id)).fetchone()
    if row is None:
        raise FundError(404, "unknown_member", f"No member {member_id!r} in this fund")
    return dict(row)


# ── units ────────────────────────────────────────────────────────────────────

def contributions(conn, fund_id: str, member_id: Optional[str] = None) -> list[dict]:
    sql, args = "SELECT * FROM fund_contributions WHERE fund_id = ?", [fund_id]
    if member_id:
        sql += " AND member_id = ?"
        args.append(member_id)
    rows = [dict(r) for r in conn.execute(sql + " ORDER BY date, created_at, rowid", args)]
    reversed_ids = {r["reverses_id"] for r in rows if r["reverses_id"]}
    import fund_slips
    slips = fund_slips.for_contributions(conn, fund_id)
    for r in rows:
        r["reversed"] = r["id"] in reversed_ids
        r["slip"] = slips.get(r["id"])
    return rows


def units_outstanding(conn, fund_id: str, as_of: Optional[str] = None) -> Decimal:
    """Units in issue: every deposit and every reversal (which carries the
    units back as a negative number), up to and including `as_of`."""
    sql, args = "SELECT units_issued FROM fund_contributions WHERE fund_id = ?", [fund_id]
    if as_of:
        sql += " AND date <= ?"
        args.append(_day(as_of, "as_of"))
    return sum((Decimal(r[0]) for r in conn.execute(sql, args)), Decimal(0))


def capital_total(conn, fund_id: str, as_of: Optional[str] = None) -> Decimal:
    sql, args = "SELECT amount_base FROM fund_contributions WHERE fund_id = ?", [fund_id]
    if as_of:
        sql += " AND date <= ?"
        args.append(_day(as_of, "as_of"))
    return sum((Decimal(r[0]) for r in conn.execute(sql, args)), Decimal(0))


def unit_price(fund: dict, nav: Optional[Decimal], units: Decimal) -> Optional[Decimal]:
    """Value of one unit. Before any unit exists it is the par the fund was
    created with; with units in issue it needs a NAV and is unknown without one."""
    if units <= 0:
        return Decimal(fund["unit_par"])
    if nav is None:
        return None
    return _q(nav / units, UNIT)


def contribute(conn, fund_id: str, *, member_id: str, account_id: str, date: str, amount,
               currency: Optional[str] = None, fx_rate=None, nav_before=None,
               price_source: str = "live", manual_unit_price=None, price_reason: str = "",
               evidence_ref: str = "", note: str = "", actor: str = "user",
               today: Optional[str] = None, slip: Optional[dict] = None) -> dict:
    """Record a member's deposit and issue its units, in the caller's transaction.

    `slip` = the bank transfer slip it was made with (`{sha256, ...fields}`,
    fund_slips.py): recorded with the deposit, and refused when that slip
    already backs another standing deposit or shows a different amount.

    `nav_before` is the fund's value in its base currency just before this
    money arrived — live for a deposit dated today, the stored snapshot for an
    earlier day. Without one the caller must give `manual_unit_price` and say
    why. The cash reaches the fund's book exactly once: the `cash_ledger` row
    is written here and nowhere else.
    """
    fund = get_fund(conn, fund_id)
    member = _member(conn, fund_id, member_id)
    acc = conn.execute("SELECT * FROM portfolio_accounts WHERE id = ?", (account_id,)).fetchone()
    if acc is None or acc["fund_id"] != fund_id:
        raise FundError(422, "not_a_fund_account", f"Account {account_id!r} does not belong to this fund")
    day = _day(date)
    now = today or _date.today().isoformat()
    if day > now:
        raise FundError(422, "future_date", f"A deposit cannot be dated in the future ({day})")
    amt = dec(amount, "amount")
    if amt <= 0:
        raise FundError(422, "bad_amount", "amount must be positive — a correction is a reversal, not a negative deposit")
    ccy = (currency or acc["currency"] or "THB").strip().upper()
    if ccy not in ("THB", "USD"):
        raise FundError(422, "bad_currency", "currency must be THB or USD")
    base = fund["base_currency"]
    # cash_ledger is kept in THB with the THB-per-unit rate of the day beside it.
    if ccy == "THB":
        rate = Decimal(1)
    else:
        if fx_rate in (None, ""):
            raise FundError(422, "fx_rate_required", f"A {ccy} deposit needs fx_rate (THB per 1 {ccy}) of that day")
        rate = dec(fx_rate, "fx_rate")
        if rate <= 0:
            raise FundError(422, "bad_fx_rate", "fx_rate must be positive")
    amount_thb = _q(amt * rate, MONEY)
    if base == "THB":
        amount_base = amount_thb
    elif ccy == base:
        amount_base = _q(amt, MONEY)
    else:   # THB into a USD fund: there is no rate on a THB deposit to convert with
        if fx_rate in (None, ""):
            raise FundError(422, "fx_rate_required", f"A THB deposit into a {base} fund needs fx_rate (THB per 1 {base})")
        amount_base = _q(amt / dec(fx_rate, "fx_rate"), MONEY)

    # Units already in issue on that day — a back-dated deposit must not be
    # priced with units that did not exist yet.
    before = units_outstanding(conn, fund_id, as_of=day)
    later = conn.execute("SELECT 1 FROM fund_contributions WHERE fund_id = ? AND date > ? LIMIT 1",
                         (fund_id, day)).fetchone()
    if later and before <= 0:
        raise FundError(422, "before_first_deposit",
                        "This date is earlier than the fund's first deposit: units already issued at par cannot be repriced")

    nav = None
    if manual_unit_price not in (None, ""):
        price = dec(manual_unit_price, "unit_price")
        if price <= 0:
            raise FundError(422, "bad_unit_price", "unit_price must be positive")
        if not (price_reason or "").strip():
            raise FundError(422, "reason_required", "A unit price typed by hand needs a reason")
        source = "manual"
        nav = dec(nav_before, "nav_before") if nav_before not in (None, "") else None
    elif before <= 0:
        price, source = Decimal(fund["unit_par"]), "par"
        nav = dec(nav_before, "nav_before") if nav_before not in (None, "") else None
    else:
        if nav_before in (None, ""):
            raise FundError(422, "nav_unknown",
                            f"The fund's value on {day} is not known, so the deposit cannot be turned into units. "
                            "Give unit_price with a reason.")
        nav = dec(nav_before, "nav_before")
        if nav <= 0:
            raise FundError(422, "nav_not_positive",
                            f"The fund's value on {day} is {nav} — units cannot be priced. Give unit_price with a reason.")
        if price_source not in ("live", "snapshot"):
            raise FundError(422, "bad_price_source", "price_source must be live or snapshot")
        price, source = _q(nav / before, UNIT), price_source
    units = _q(amount_base / price, UNIT)
    if units <= 0:
        raise FundError(422, "no_units", "The deposit is too small to buy any unit at this price")

    import ledger
    cash_id, row_id = str(uuid.uuid4()), str(uuid.uuid4())
    wallet = ledger.entry_wallet(conn, account_id, "THB", None, None)
    conn.execute(
        "INSERT INTO cash_ledger (id, account_id, date, income, investment, exchange_rate, note, entry_type, wallet) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (cash_id, account_id, day, float(amount_thb), float(amount_thb), float(rate),
         f"FUND deposit — {member['name']}" + (f" · {note}" if note else ""), "DEPOSIT", wallet))
    conn.execute(
        "INSERT INTO fund_contributions (id, fund_id, member_id, account_id, date, amount, currency, fx_rate, "
        "amount_base, nav_before, units_before, unit_price, units_issued, price_source, price_reason, "
        "evidence_ref, cash_ledger_id, entered_by, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (row_id, fund_id, member_id, account_id, day, str(_q(amt, MONEY)), ccy, str(rate), str(amount_base),
         str(nav) if nav is not None else None, str(before), str(price), str(units), source,
         (price_reason or "").strip(),
         evidence_ref or (str((slip or {}).get("ref_code") or "").strip()), cash_id, actor or "user", note or ""))
    row = dict(conn.execute("SELECT * FROM fund_contributions WHERE id = ?", (row_id,)).fetchone())
    if slip:
        import fund_slips
        try:
            row["slip"] = fund_slips.attach(conn, fund_id, row, slip, actor=actor)
        except ValueError as exc:
            code, detail = exc.args
            raise FundError(409 if code == "slip_already_used" else 422, code, detail)
    return row


def reverse(conn, fund_id: str, contribution_id: str, *, reason: str, actor: str = "user",
            today: Optional[str] = None) -> dict:
    """Undo a deposit typed by mistake: a mirror row that takes the money and
    the units back, and a cash row that takes the cash back. Not a withdrawal
    — a member leaving with their share is a different thing (plan O1)."""
    get_fund(conn, fund_id)
    row = conn.execute("SELECT rowid AS _rowid, * FROM fund_contributions WHERE id = ? AND fund_id = ?",
                       (contribution_id, fund_id)).fetchone()
    if row is None:
        raise FundError(404, "unknown_contribution", f"No deposit {contribution_id!r} in this fund")
    if row["reverses_id"]:
        raise FundError(409, "is_a_reversal", "A reversal cannot be reversed — enter the deposit again")
    if conn.execute("SELECT 1 FROM fund_contributions WHERE reverses_id = ?", (contribution_id,)).fetchone():
        raise FundError(409, "already_reversed", "This deposit has already been reversed")
    if not (reason or "").strip():
        raise FundError(422, "reason_required", "A reversal needs a reason")
    # Units issued after it were priced with its money in the fund: taking it
    # out now would leave those prices describing a fund that never existed.
    # (A later deposit that was itself reversed no longer stands in the way.)
    if conn.execute("SELECT 1 FROM fund_contributions c WHERE c.fund_id = ? AND c.id != ? AND c.reverses_id IS NULL "
                    "AND NOT EXISTS (SELECT 1 FROM fund_contributions r WHERE r.reverses_id = c.id) "
                    "AND (c.date > ? OR (c.date = ? AND c.rowid > ?))",
                    (fund_id, contribution_id, row["date"], row["date"], row["_rowid"])).fetchone():
        raise FundError(409, "later_deposits_exist",
                        "A later deposit was priced with this one in the fund. Reverse the later ones first.")
    import ledger
    cash_id, rev_id = str(uuid.uuid4()), str(uuid.uuid4())
    amount_thb = _q(Decimal(row["amount"]) * Decimal(row["fx_rate"]), MONEY)
    wallet = ledger.entry_wallet(conn, row["account_id"], "THB", None, None)
    conn.execute(
        "INSERT INTO cash_ledger (id, account_id, date, income, investment, exchange_rate, note, entry_type, wallet) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (cash_id, row["account_id"], row["date"], float(amount_thb), -float(amount_thb), float(Decimal(row["fx_rate"])),
         f"FUND deposit reversed — {reason.strip()}", "WITHDRAW", wallet))
    conn.execute(
        "INSERT INTO fund_contributions (id, fund_id, member_id, account_id, date, amount, currency, fx_rate, "
        "amount_base, nav_before, units_before, unit_price, units_issued, price_source, price_reason, "
        "evidence_ref, cash_ledger_id, entered_by, reverses_id, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (rev_id, fund_id, row["member_id"], row["account_id"], row["date"], str(-Decimal(row["amount"])),
         row["currency"], row["fx_rate"], str(-Decimal(row["amount_base"])), row["nav_before"], row["units_before"],
         row["unit_price"], str(-Decimal(row["units_issued"])), row["price_source"], row["price_reason"],
         row["evidence_ref"], cash_id, actor or "user", contribution_id, reason.strip()))
    return dict(conn.execute("SELECT * FROM fund_contributions WHERE id = ?", (rev_id,)).fetchone())


# ── who holds what ───────────────────────────────────────────────────────────

def _share(part: Decimal, whole: Decimal) -> Optional[str]:
    return str(_q(part / whole * 100, Decimal("0.0001"))) if whole > 0 else None


def members_view(conn, fund_id: str, nav: Optional[Decimal] = None) -> dict:
    """Every member with both measures side by side, all sums done here over
    every row: capital (what results are shared by) and units (what the money
    bought). `nav` — the fund's value now, when the caller could value it."""
    fund = get_fund(conn, fund_id)
    rows = conn.execute(
        "SELECT member_id, amount_base, units_issued FROM fund_contributions WHERE fund_id = ?", (fund_id,)).fetchall()
    capital: dict[str, Decimal] = {}
    units: dict[str, Decimal] = {}
    for r in rows:
        capital[r["member_id"]] = capital.get(r["member_id"], Decimal(0)) + Decimal(r["amount_base"])
        units[r["member_id"]] = units.get(r["member_id"], Decimal(0)) + Decimal(r["units_issued"])
    total_capital = sum(capital.values(), Decimal(0))
    total_units = sum(units.values(), Decimal(0))
    price = unit_price(fund, nav, total_units)
    out = []
    for m in conn.execute("SELECT * FROM fund_members WHERE fund_id = ? ORDER BY created_at, name", (fund_id,)):
        c, u = capital.get(m["id"], Decimal(0)), units.get(m["id"], Decimal(0))
        value_units = _q(u * price, MONEY) if price is not None and total_units > 0 else None
        value_capital = _q(nav * c / total_capital, MONEY) if nav is not None and total_capital > 0 else None
        out.append({
            **dict(m),
            "capital": str(_q(c, MONEY)), "capital_share_pct": _share(c, total_capital),
            "units": str(_q(u, UNIT)), "units_share_pct": _share(u, total_units),
            # What the member's stake is worth under each measure. The rule
            # in force says which one counts; the other is the comparison.
            "value_by_capital": str(value_capital) if value_capital is not None else None,
            "value_by_units": str(value_units) if value_units is not None else None,
        })
    rule = split_rule(conn, fund_id)
    return {
        "fund_id": fund_id, "base_currency": fund["base_currency"],
        "split_basis": rule["basis"] if rule else None,
        "capital_total": str(_q(total_capital, MONEY)), "units_total": str(_q(total_units, UNIT)),
        "nav": str(_q(nav, MONEY)) if nav is not None else None,
        "unit_price": str(price) if price is not None else None,
        "members": out,
    }
