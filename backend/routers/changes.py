"""GET /api/changes — per-table versions for the frontend's change feed.

Cheap (one indexed read of a tiny table); the heartbeat asks every 15 s.
See change_feed.py.
"""
from fastapi import APIRouter

import change_feed

router = APIRouter()


@router.get("/api/changes")
def get_changes():
    return {"tables": change_feed.versions()}
