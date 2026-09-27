"""Broker slip layouts. Each module exposes `claims(tokens) -> bool` and
`parse(tokens) -> slip`; the first that claims the tokens parses them.

A module may also define `validate(slip, fee_schedule)` and `to_form(slip,
checks)` when its instrument is not a stock (dime_option); otherwise the
engine's stock ones are used. Order matters: the option layout carries the
stock layout's labels too, so it must be asked first."""
from __future__ import annotations

from types import ModuleType

from ..layout import Token
from . import dime, dime_option

PARSERS: list[ModuleType] = [dime_option, dime]


def detect(tokens: list[Token]) -> ModuleType | None:
    return next((p for p in PARSERS if p.claims(tokens)), None)
