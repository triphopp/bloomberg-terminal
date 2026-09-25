"""Re-book the Finansia 6065151/6065157 portfolio as an in-kind takeover.

The user did not buy these lots: the portfolio was handed over for management
on 2026-02-08. They were booked as 2025-01-01 "buys" at the previous owner's
cost (placeholder date), and the ฿1,883,714.06 that funded them was moved to
2025-12-31 to keep cash positive. Fund practice (GIPS) instead records an
in-kind contribution at fair value on the transfer date and measures returns
from there; the previous owner's cost is memo only.

What --apply changes (one transaction, SQLite online backup first):
  trades        10 lots: date_entry -> 2026-02-08, price_entry/amount -> last
                close on or before the transfer date, acquisition_type =
                TRANSFER_IN, original_price_entry = old price_entry,
                transfer_price_entry = the close.
  cash_ledger   the two opening rows -> 2026-02-08:
                  in-kind securities at fair value (sum of the closes x qty)
                  cash brought in = 1,883,714.06 - prior cost 1,457,602.00
                  (derived: the recorded total is prior cost + cash; replace
                  with the statement figure when available)
  nav snapshots live rows (finansia + all, all >= 2026-02-08): open_cost_basis
                and unrealized_pnl shifted by (prior cost - fair value), exactly
                what the re-basing changes while every lot is held. Every
                source='backfill' row is deleted — they were rebuilt from the old
                placeholder dates (TTW/ICHI/BH too) — rebuild them with
                scripts/backfill_nav.py --validate, then --apply.

Cash is unchanged by construction: invested capital and open cost both drop
by the same amount.

    python scripts/apply_portfolio_takeover.py            # dry run
    python scripts/apply_portfolio_takeover.py --apply
"""
from __future__ import annotations

import argparse
import io
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import DB_PATH  # noqa: E402

TRANSFER_DATE = "2026-02-08"
LOT_IDS = (
    "3a5ad799-44e1-4b9d-b4a7-97f0536dfeda",  # AJ     6065157
    "829448fe-f628-4b5b-8524-edec1a745ad4",  # DCON   6065157
    "5eea53f6-e63c-4454-bd75-2fe861d1fd58",  # DCON   6065151
    "590f8204-dca8-4990-ab00-30ca2f2f9426",  # DMT    6065157
    "f28add34-5571-4e91-aed6-9cdf47208aca",  # LOXLEY 6065151
    "1682bf6d-31ea-49b6-a9ab-3607df4f7786",  # OR     6065157
    "c67da35c-ef81-49e6-b4e9-a567ffb1e56f",  # OR     6065151
    "24e63349-856c-4454-b766-4df42e05aa4d",  # TASCO  6065157
    "87f6c9fa-e66e-4692-adbc-16a0ff36556e",  # TASCO  6065151
    "8064c66f-cc46-4528-923d-8ec08f99c0c4",  # XPG    6065157
)
CASH_IN_KIND = "43a61e8b-967d-4ada-a043-c6f3d15967bd"   # was 1,397,002.00
CASH_CASH = "71cc5218-0e80-4ec8-aecb-0ddd26fbc73e"      # was 486,712.06
RECORDED_TOTAL = 1397002.0 + 486712.06
BACKUPS = Path(__file__).resolve().parents[1] / "backups" / "portfolio-reconciliation"
REASON = "User-confirmed 2026-09-26: portfolio taken over for management on 2026-02-08; in-kind transfer at fair value (fund practice)"


def closes(symbols):
    """Last close on or before the transfer date, raw (no dividend adjustment)."""
    end = (date.fromisoformat(TRANSFER_DATE) + timedelta(days=1)).isoformat()
    out = {}
    for s in symbols:
        h = yf.Ticker(f"{s}.BK").history(start="2026-01-20", end=end, auto_adjust=False)
        if h.empty:
            raise SystemExit(f"no close for {s}.BK before {TRANSFER_DATE}")
        out[s] = (h.index[-1].date().isoformat(), round(float(h["Close"].iloc[-1]), 4))
    return out


def plan(conn):
    lots = [dict(r) for r in conn.execute(
        f"SELECT * FROM trades WHERE id IN ({','.join('?' * len(LOT_IDS))})", LOT_IDS)]
    if len(lots) != len(LOT_IDS):
        raise SystemExit("lot set changed — re-check before applying")
    for t in lots:
        if t.get("acquisition_type") == "TRANSFER_IN":
            raise SystemExit(f"already applied: {t['symbol']} {t['id']}")
        if t["date_entry"] != "2025-01-01" or t["win_loss"] != "P" or t["account_id"] != "finansia":
            raise SystemExit(f"lot no longer the untouched placeholder: {t['symbol']} {t['id']}")
    px = closes(sorted({t["symbol"] for t in lots}))
    prior = sum(t["price_entry"] * t["volume"] for t in lots)
    fair = sum(px[t["symbol"]][1] * t["volume"] for t in lots)
    cash_rows = {r["id"]: dict(r) for r in conn.execute(
        "SELECT * FROM cash_ledger WHERE id IN (?, ?)", (CASH_IN_KIND, CASH_CASH))}
    if len(cash_rows) != 2 or abs(sum(r["investment"] for r in cash_rows.values()) - RECORDED_TOTAL) > 0.01:
        raise SystemExit("opening cash rows changed — re-check before applying")
    cash_in = round(RECORDED_TOTAL - prior, 2)
    return lots, px, round(prior, 2), round(fair, 2), cash_in


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DB_PATH))
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    conn = sqlite3.connect(a.db)
    conn.row_factory = sqlite3.Row
    lots, px, prior, fair, cash_in = plan(conn)
    delta = round(prior - fair, 2)
    print(f"== takeover {TRANSFER_DATE} {'APPLY' if a.apply else 'DRY RUN'}")
    for t in sorted(lots, key=lambda t: t["symbol"]):
        d, c = px[t["symbol"]]
        print(f"  {t['symbol']:7} {t['volume']:>10,.0f}  prior {t['price_entry']:>7.2f}  close {d} {c:>7.2f}  "
              f"inherited {(c - t['price_entry']) * t['volume']:>12,.2f}")
    print(f"  prior cost {prior:,.2f}  fair value {fair:,.2f}  inherited {fair - prior:,.2f}")
    print(f"  cash rows -> {TRANSFER_DATE}: in-kind {fair:,.2f} + cash {cash_in:,.2f} "
          f"(was {RECORDED_TOTAL:,.2f} on 2025-12-31); capital in drops {delta:,.2f}")
    n_after = conn.execute("SELECT COUNT(*) FROM portfolio_nav_snapshots WHERE account_id IN ('finansia','all') AND snapshot_date >= ? AND source <> 'backfill'", (TRANSFER_DATE,)).fetchone()[0]
    n_backfill = conn.execute("SELECT COUNT(*) FROM portfolio_nav_snapshots WHERE source = 'backfill'").fetchone()[0]
    live_before = conn.execute("SELECT COUNT(*) FROM portfolio_nav_snapshots WHERE snapshot_date < ? AND source <> 'backfill'", (TRANSFER_DATE,)).fetchone()[0]
    print(f"  nav snapshots: shift {n_after} live rows; delete {n_backfill} backfill rows (live rows before transfer: {live_before})")
    if live_before:
        raise SystemExit("live snapshots exist before the transfer date — not safe to delete")
    if not a.apply:
        return 0

    BACKUPS.mkdir(parents=True, exist_ok=True)
    backup = BACKUPS / f"portfolio-pre-takeover-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.db"
    with sqlite3.connect(backup) as dest:
        conn.backup(dest)
        if dest.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("backup integrity check failed")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("UPDATE _audit_context SET reason=?", (REASON,))
        for t in lots:
            d, c = px[t["symbol"]]
            conn.execute(
                """UPDATE trades SET date_entry=?, price_entry=?, amount=?, exchange_rate=1.0,
                   acquisition_type='TRANSFER_IN', original_price_entry=?, transfer_price_entry=?,
                   note=COALESCE(note,'') || ? WHERE id=?""",
                (TRANSFER_DATE, c, round(c * t["volume"], 2), t["price_entry"], c,
                 f" | TAKEOVER {TRANSFER_DATE}: in-kind at close {d} {c}; previous owner's cost {t['price_entry']}",
                 t["id"]),
            )
        conn.execute("UPDATE cash_ledger SET date=?, income=?, investment=?, note=? WHERE id=?",
                     (TRANSFER_DATE, fair, fair,
                      f"TAKEOVER in-kind: 10 lots at fair value (closes on/before {TRANSFER_DATE}); previous owner's cost {prior:,.2f}",
                      CASH_IN_KIND))
        conn.execute("UPDATE cash_ledger SET date=?, income=?, investment=?, note=? WHERE id=?",
                     (TRANSFER_DATE, cash_in, cash_in,
                      f"TAKEOVER cash: derived {RECORDED_TOTAL:,.2f} recorded - {prior:,.2f} prior cost; confirm with statement",
                      CASH_CASH))
        conn.execute("""UPDATE portfolio_nav_snapshots SET open_cost_basis = open_cost_basis - ?,
                        unrealized_pnl = unrealized_pnl + ?
                        WHERE account_id IN ('finansia','all') AND snapshot_date >= ? AND source <> 'backfill'""",
                     (delta, delta, TRANSFER_DATE))
        conn.execute("DELETE FROM portfolio_nav_snapshots WHERE source = 'backfill'")
        conn.execute("UPDATE _audit_context SET reason=NULL")
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("post-write integrity check failed")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    print(f"applied; backup {backup}")
    print("next: python scripts/backfill_nav.py --validate, then --apply  (rebuilds 2026-01-01 -> first live snapshot)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
