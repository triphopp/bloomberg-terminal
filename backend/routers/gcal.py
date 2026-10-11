"""
/api/gcal — the CAL view pushed into Google Calendar (backend/gcal_sync.py).

One way: the terminal's dates go up, nothing comes back. Connect runs Google's
sign-in in the browser and returns to `/api/gcal/callback` on this backend
directly (a loopback redirect — the browser is on the same machine), so connect
from the machine that runs the app, not from a phone on the LAN.
"""
from __future__ import annotations

import html
import threading

from fastapi import APIRouter, Body, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse

import gcal_sync as gc

router = APIRouter()


def _fail(exc: gc.GcalError) -> HTTPException:
    return HTTPException(exc.status, {"error": str(exc), "code": exc.code})


@router.get("/api/gcal/status")
def gcal_status():
    """Connected or not, the calendar, the categories that go up, the last pass. Never a token."""
    return gc.status()


@router.post("/api/gcal/connect")
def gcal_connect(request: Request):
    """The Google sign-in URL for the page to open. Google comes back to /api/gcal/callback."""
    redirect = str(request.base_url).rstrip("/") + "/api/gcal/callback"
    try:
        return {"auth_url": gc.start_auth(redirect), "redirect_uri": redirect}
    except gc.GcalError as exc:
        raise _fail(exc) from None


_PAGE = """<!doctype html><meta charset="utf-8"><title>Google Calendar</title>
<body style="background:#000;color:{color};font:13px/1.5 ui-monospace,monospace;padding:24px">
<p>{text}</p><p style="color:#888">{sub}</p>
<script>try{{window.opener&&window.opener.postMessage("gcal:{kind}","*")}}catch(e){{}}
{close}</script></body>"""


@router.get("/api/gcal/callback", response_class=HTMLResponse)
async def gcal_callback(state: str = Query(""), code: str = Query(""), error: str = Query("")):
    if error:
        msg, ok = f"Google sign-in was not completed ({error}).", False
    else:
        try:
            await run_in_threadpool(gc.finish_auth, state, code)
            # The first pass can take a minute (one call per event): not on this page's time.
            threading.Thread(target=gc.run_if_connected, daemon=True, name="gcal-first-sync").start()
            msg, ok = "Google Calendar connected — the Bloomberg Terminal calendar is being filled.", True
        except gc.GcalError as exc:
            msg, ok = str(exc), False
    return HTMLResponse(_PAGE.format(
        color="#4ade80" if ok else "#f87171", text=html.escape(msg),
        sub="You can close this tab and go back to CAL." if ok else "Go back to CAL and press CONNECT again.",
        kind="ok" if ok else "error", close="setTimeout(function(){window.close()},1500)" if ok else ""),
        status_code=200 if ok else 400)


@router.post("/api/gcal/sync")
async def gcal_sync_now():
    """One pass now (the calendar scheduler also runs one every CALENDAR_SCAN_INTERVAL)."""
    try:
        return await run_in_threadpool(gc.sync)
    except gc.GcalError as exc:
        raise _fail(exc) from None


@router.put("/api/gcal/settings")
def gcal_settings(body: dict = Body(...)):
    """{categories: [MACRO|COMPANY|THESIS|PORT], macro_impact: high|medium|all}. A change pushes
    a pass, so an unticked category leaves Google straight away."""
    saved = gc.save_settings(body)
    if gc.status()["connected"]:
        threading.Thread(target=gc.run_if_connected, daemon=True, name="gcal-settings-sync").start()
    return {"settings": saved}


@router.post("/api/gcal/disconnect")
async def gcal_disconnect(delete_calendar: bool = Query(False, description="also delete the calendar in Google")):
    try:
        return await run_in_threadpool(gc.disconnect, delete_calendar)
    except gc.GcalError as exc:
        raise _fail(exc) from None
