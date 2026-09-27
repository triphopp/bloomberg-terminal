"""
/api/sync/* — portfolio cloud-sync status + manual pull/push.

Two engines: the legacy snapshot merge (sync/manager.py) and the op log
(sync/oplog.py, OPLOG_ENABLED=true). Status keeps the snapshot fields the
header chip reads and adds the op-log ones when that engine is on.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import sync
from db import connect
from sync import oplog

router = APIRouter()


@router.get("/api/sync/status")
def sync_status():
    if not oplog.enabled():
        return sync.get_status()
    st = oplog.app_status()
    return {
        **st,
        # fields the header chip already reads
        "enabled": st["root"] is not None,
        "sync_dir": st["root"],
        "reachable": st["root"] is not None and st.get("last_error") is None,
        "last_pull": st.get("last_sync"),
        "last_push": st.get("last_sync"),
        "last_conflicts": st["open_conflicts"],
    }


@router.post("/api/sync/pull")
def sync_pull():
    if oplog.enabled():
        return _sync_now()
    return sync.pull()


@router.post("/api/sync/push")
def sync_push():
    if oplog.enabled():
        return _sync_now()
    return sync.push()


def _sync_now():
    root = oplog.root_dir()
    if root is None:
        raise HTTPException(status_code=503, detail="cloud folder not found")
    conn = connect()
    try:
        return {"status": "ok", **oplog.sync_once(conn, oplog.device_id(), root)}
    finally:
        conn.close()


@router.post("/api/sync/now")
def sync_now():
    if not oplog.enabled():
        raise HTTPException(status_code=409, detail="op-log sync is off (OPLOG_ENABLED)")
    return _sync_now()


@router.get("/api/sync/conflicts")
def sync_conflicts(all: bool = False):
    conn = connect(readonly=True)
    try:
        try:
            return {"conflicts": oplog.conflicts(conn, open_only=not all)}
        except Exception:
            return {"conflicts": []}  # op-log tables not installed yet
    finally:
        conn.close()


class ResolveIn(BaseModel):
    choice: str  # "kept" | "other"


@router.post("/api/sync/conflicts/{conflict_id}/resolve")
def sync_resolve(conflict_id: str, body: ResolveIn):
    conn = connect()
    try:
        try:
            out = oplog.resolve(conn, oplog.device_id(), conflict_id, body.choice)
        except KeyError:
            raise HTTPException(status_code=404, detail="conflict not found")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    finally:
        conn.close()
    oplog.request_sync()
    return out
