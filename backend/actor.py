"""Who is making a write: the UI, or an agent through the MCP server.

The value rides on the `X-Thesis-Actor` header and is stamped onto whatever the
route records (a thesis event's payload, a zettel row's `actor` column), so the
timeline can show which changes were not the user's own.

`_capture_actor` is async ON PURPOSE. A router dependency that is `async def`
runs inside the request task, so the ContextVar it sets is part of the context
that Starlette copies into the threadpool where a sync endpoint runs. A plain
`def` dependency is itself pushed to the threadpool, and the value would never
reach the endpoint — every agent write would read back as "user".
"""
from contextvars import ContextVar
from typing import Optional

from fastapi import Header

_actor: ContextVar[str] = ContextVar("actor", default="user")


async def capture_actor(x_thesis_actor: Optional[str] = Header(None)) -> None:
    _actor.set((x_thesis_actor or "user").strip()[:64] or "user")


def current_actor() -> str:
    return _actor.get()


def is_agent() -> bool:
    return current_actor() != "user"
