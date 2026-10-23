"""How a symbol and its name are shown — one place, backend side.

The frontend mirror is `components/bloomberg/lib/symbol-display.ts`; the two
must give the same answer (tests/test_symbol_names.py and
lib/__tests__/symbol-display.test.ts pin the same cases).

  ^MOVE                    → MOVE                  (index caret)
  BH.BK / ^SET.BK          → BH / SET              (exchange suffix)
  BH_BUMRUNGRAD HOSPITAL   → BUMRUNGRAD HOSPITAL   (ticker prefix Yahoo puts on Thai names)

Display only. Quote, history, pin and every other API call keep the provider
symbol (`^MOVE`, `BH.BK`) — a display symbol fed back in finds another ticker
(`MOVE` alone is not the MOVE index).

Some names Yahoo gives are not the instrument's name at all: `^MOVE` reads
"Northern Trust iBoxx 5-Year Tar…" while its series is the ICE BofA MOVE index
(gotchas.md, 2026-10-07). Those are corrected in `NAME_FIXES`, which is a fix
of the data, so the quote carries the right longName / shortName to every
consumer — ASK included.
"""

from __future__ import annotations

# Suffixes hidden from display. Extend here and in symbol-display.ts.
HIDDEN_SUFFIXES = (".BK",)

# Provider symbol → its real name, where Yahoo's is wrong.
NAME_FIXES: dict[str, str] = {
    "^MOVE": "ICE BofA MOVE Index",
}


def _base(symbol: str) -> str:
    """Ticker without caret or exchange suffix: ^SET.BK → SET, BH.BK → BH."""
    return symbol.lstrip("^").split(".")[0]


def display_symbol(symbol: str) -> str:
    sym = (symbol or "").strip()
    if sym.startswith("^"):
        sym = sym[1:]
    upper = sym.upper()
    for suf in HIDDEN_SUFFIXES:
        if upper.endswith(suf):
            return sym[: -len(suf)]
    return sym


def fix_name(symbol: str, name: str | None) -> str | None:
    """The instrument's real name where the provider's is wrong, else `name` as given."""
    return NAME_FIXES.get((symbol or "").strip().upper(), name)


def display_name(symbol: str, name: str | None) -> str:
    name = (fix_name(symbol, name) or "").strip()
    base = _base((symbol or "").strip()).upper()
    if base and name.upper().startswith(f"{base}_"):
        return name[len(base) + 1:].strip()
    return name
