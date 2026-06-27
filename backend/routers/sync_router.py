"""
/api/sync/* — portfolio cloud-sync status + manual pull/push.
"""
from fastapi import APIRouter

import sync

router = APIRouter()


@router.get("/api/sync/status")
def sync_status():
    return sync.get_status()


@router.post("/api/sync/pull")
def sync_pull():
    return sync.pull()


@router.post("/api/sync/push")
def sync_push():
    return sync.push()
