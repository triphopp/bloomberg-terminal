"""
Backfill trades.resolved_symbol / trades.market for rows created before the
symbol resolver existed (plans/port-redesign.md Step 4, closes F06).

Uses the same deterministic mapping the legacy _get_yf_symbol applied at read
time for the three original accounts, so the persisted value matches what the
price path has always fetched:

  finansia   → SYM.BK           market TH
  innovestx  → BTCTHB → BTC-THB market CRYPTO
  others     → SYM as-is        market US

Options rows (PUT_/CALL_ prefixes) are left NULL — they never had live quotes.
Idempotent: only touches rows where resolved_symbol IS NULL.

Run: cd backend && python scripts/backfill_resolved_symbols.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import get_db  # noqa: E402
from routers.portfolio_v2 import _get_yf_symbol  # noqa: E402


def _market_for(resolved: str) -> str:
    if resolved.endswith(".BK"):
        return "TH"
    if "-" in resolved:
        return "CRYPTO"
    return "US"


def main() -> None:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, symbol, account_id FROM trades WHERE resolved_symbol IS NULL"
        ).fetchall()
        updated = skipped = 0
        for r in rows:
            resolved = _get_yf_symbol(r["symbol"], r["account_id"])
            if not resolved:
                skipped += 1  # options / unmappable — legitimately no provider symbol
                continue
            conn.execute(
                "UPDATE trades SET resolved_symbol = ?, market = ? WHERE id = ?",
                (resolved, _market_for(resolved), r["id"]),
            )
            updated += 1
        remaining = conn.execute(
            "SELECT COUNT(*) FROM trades WHERE resolved_symbol IS NULL"
        ).fetchone()[0]
    print(f"scanned={len(rows)} updated={updated} skipped(options/unmappable)={skipped} "
          f"still_null={remaining}")


if __name__ == "__main__":
    main()
