"""
GET  /api/dev/status  — is the running backend the code on disk? (dev_status.py)
POST /api/dev/restart — restart it the way it can be restarted.

Restart requires the `X-BT-Dev: 1` header: a custom header forces a CORS
preflight, so another site open in the browser cannot restart the server with
a plain form POST.
"""
from fastapi import APIRouter, Header, HTTPException

import dev_status

router = APIRouter(prefix="/api/dev", tags=["dev"])


@router.get("/status")
def get_status():
    return dev_status.status()


@router.post("/restart")
def restart(x_bt_dev: str | None = Header(default=None)):
    if x_bt_dev != "1":
        raise HTTPException(status_code=403, detail="missing X-BT-Dev header")
    mode = dev_status.request_restart()
    if mode is None:
        raise HTTPException(
            status_code=409,
            detail="backend was started by hand without --reload — restart it in its terminal",
        )
    return {"ok": True, "mode": mode, "pid": dev_status.status()["pid"]}
