"""
Quote-provider control endpoints.

Lets the UI see which price vendors exist, their health, and the active one,
and switch the active provider or toggle auto-failover at runtime.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from sources import registry

router = APIRouter(prefix="/api/providers")


class ActiveIn(BaseModel):
    name: str


class FailoverIn(BaseModel):
    enabled: bool


@router.get("")
def list_providers():
    """All registered quote providers with health + active flags."""
    return {
        "active": registry.active,
        "providers": registry.status(),
    }


@router.post("/active")
def set_active(body: ActiveIn):
    """Manually pin the active quote provider."""
    if not registry.set_active(body.name):
        raise HTTPException(status_code=404, detail=f"Unknown provider: {body.name}")
    return {"ok": True, "active": registry.active}


@router.post("/auto-failover")
def set_auto_failover(body: FailoverIn):
    """Enable/disable automatic failover to the next healthy provider."""
    registry.set_auto_failover(body.enabled)
    return {"ok": True, "auto_failover": body.enabled}
