"""
GET /api/health/upstream — the state of every data vendor the backend talks to.

Reads `upstream_health` only; never makes an outbound call itself, so the UI
can poll it cheaply even while the network is down.
"""

from fastapi import APIRouter

import upstream_health
import yahoo_gate

router = APIRouter(prefix="/api/health", tags=["health"])


@router.get("/upstream")
def get_upstream():
    snap = upstream_health.snapshot()
    snap["yahoo_gate"] = {"installed": yahoo_gate.INSTALLED, "max_concurrent": yahoo_gate.MAX_CONCURRENT}
    return snap
