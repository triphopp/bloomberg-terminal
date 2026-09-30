"""Sub-portfolio of a trade row, read from its note.

A broker account can hold several sub-accounts (Finansia 0153717 / 6065151 /
6065157). The sub-port lives in the note's leading segment —
"Finansia (6065151) | free text | VAT: 7" — written by the ENTRY form
(views/portfolio/helpers.ts `composeNote`). Closed rows get "\\n[SOLD …]"
appended straight after it, so lines split segments too.

Average cost is pooled per (account, symbol, sub-port): two sub-accounts that
hold the same stock are two positions at the broker, each with its own average.
Rows with no sub-port share the "" pool — every account without sub-accounts.

Mirrors `splitNote` / `subPortLabel` in views/portfolio/helpers.ts.
"""
from __future__ import annotations

import re
from typing import Optional

# "<account name> (<id>)" — a name with no ; ( ) so a free-text note that
# happens to end in a parenthesis ("… (price-match; was 2026-06-06)") is not
# taken for a sub-port.
_SEG_RE = re.compile(r"[^();|\n]+\s\(([^()]+)\)")


def sub_port_segment(note: Optional[str]) -> str:
    """The whole tag, e.g. "Finansia (6065151)", or "". Only the FIRST segment
    counts — composeNote always writes the tag first."""
    first = next((p.strip() for p in re.split(r" \| |\n", note or "") if p.strip()), "")
    return first if _SEG_RE.fullmatch(first) and not first.startswith("VAT:") else ""


def sub_port_of(note: Optional[str]) -> str:
    """The sub-port id, e.g. "6065151", or "" when the row has none."""
    m = _SEG_RE.fullmatch(sub_port_segment(note))
    return m.group(1) if m else ""


def split_accounts(conn) -> set[str]:
    """Accounts whose trades carry two or more sub-ports — only those pool
    average cost per sub-port. One tag on an account ("Dime (TH DIME)" on a
    single row) is a label, not a second position: splitting on it would move
    that row out of its symbol's pool."""
    seen: dict[str, set[str]] = {}
    for r in conn.execute("SELECT account_id, note FROM trades WHERE note LIKE '%(%)%'"):
        sp = sub_port_of(r[1])
        if sp:
            seen.setdefault(r[0], set()).add(sp)
    return {a for a, subs in seen.items() if len(subs) >= 2}


def pool_of(conn, account_id: str, note: Optional[str],
            split: Optional[set[str]] = None) -> str:
    """The AVCO pool a row belongs to within its (account, symbol)."""
    split = split_accounts(conn) if split is None else split
    return sub_port_of(note) if account_id in split else ""
