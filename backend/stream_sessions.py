"""Quote-stream sessions: one SSE pipe per page, interest changed by diff.

Before this, every change to a page's symbol set (switch chart symbol, change
timeframe, open a panel) closed the EventSource and opened a new one for the
whole set: the backend released and re-acquired every symbol, and Yahoo sends
no snapshot on subscribe, so prices went quiet until the next trade.

Now a page keeps one stream tied to a session id it chooses, and changes what
the session watches with `POST /api/stream/interest` — only the difference is
acquired/released in `quote_stream`. A dropped stream that reconnects within
`grace_s` resumes the same session (its symbols never left the hub); after
that the session is reaped and everything it held is released.

Pure bookkeeping: `acquire` / `release` are injected (quote_stream's in
production, recorders in tests). Multi-instance note: a session lives on the
instance that holds its SSE connection, so interest updates must reach that
instance (route by session id); an unknown session answers "not found" and the
client reopens — self-healing without sticky routing, just slower.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Sequence

_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")


def valid_id(session_id: str | None) -> bool:
    return bool(session_id) and bool(_ID_RE.match(session_id))


def _tier_map(tiers: Sequence[Sequence[str]]) -> dict[str, int]:
    """symbol → best tier it was given (lists are best-first)."""
    out: dict[str, int] = {}
    for t, group in enumerate(tiers):
        for s in group:
            out.setdefault(s, t)
    return out


@dataclass
class Session:
    id: str
    tiers: dict[str, int]
    attached: int = 0
    # True when the last attach found the session alive (a reconnect/return):
    # it kept its stored interest, which may differ from the URL it came with.
    resumed: bool = False
    detached_at: float | None = None
    # Symbols the stream should send a cached snapshot for on its next frame:
    # all of them on (re)attach, the new ones after an interest change.
    pending_snapshot: set[str] = field(default_factory=set)

    def symbols(self) -> list[str]:
        return sorted(self.tiers, key=lambda s: (self.tiers[s], s))


class SessionRegistry:
    def __init__(
        self,
        acquire: Callable[[list[str], int], None],
        release: Callable[[list[str], int], None],
        *,
        grace_s: float = 30.0,
        max_sessions: int = 1000,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._acquire = acquire
        self._release = release
        self.grace_s = grace_s
        self.max_sessions = max_sessions
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions: dict[str, Session] = {}

    # ── helpers ─────────────────────────────────────────────────────────────
    def _apply(self, old: dict[str, int], new: dict[str, int]) -> None:
        """Acquire first, then release: a symbol moving tier never drops to
        zero refs in between (which would unsubscribe and resubscribe it)."""
        acq: dict[int, list[str]] = {}
        rel: dict[int, list[str]] = {}
        for s, t in new.items():
            if old.get(s) != t:
                acq.setdefault(t, []).append(s)
        for s, t in old.items():
            if new.get(s) != t:
                rel.setdefault(t, []).append(s)
        for t, syms in acq.items():
            self._acquire(syms, t)
        for t, syms in rel.items():
            self._release(syms, t)

    # ── API ─────────────────────────────────────────────────────────────────
    def attach(self, session_id: str, tiers: Sequence[Sequence[str]]) -> Session | None:
        """A stream connected. Existing session (a reconnect) keeps its own
        interest — the URL's symbols may be stale; a new one takes `tiers`.
        None when the registry is full."""
        with self._lock:
            self._reap_locked()
            s = self._sessions.get(session_id)
            if s is None:
                if len(self._sessions) >= self.max_sessions:
                    return None
                s = Session(id=session_id, tiers=_tier_map(tiers))
                self._apply({}, s.tiers)
                self._sessions[session_id] = s
            else:
                s.resumed = True
            s.attached += 1
            s.detached_at = None
            s.pending_snapshot = set(s.tiers)
            return s

    def update(self, session_id: str, tiers: Sequence[Sequence[str]]) -> Session | None:
        """Replace the session's interest by diff. None = unknown session."""
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None:
                return None
            new = _tier_map(tiers)
            self._apply(s.tiers, new)
            s.pending_snapshot |= {sym for sym in new if sym not in s.tiers}
            s.pending_snapshot &= set(new)
            s.tiers = new
            return s

    def detach(self, session_id: str) -> None:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None:
                return
            s.attached = max(0, s.attached - 1)
            if s.attached == 0:
                s.detached_at = self._clock()

    def drop(self, session_id: str) -> None:
        """Release a session now (a sessionless stream that ended)."""
        with self._lock:
            s = self._sessions.pop(session_id, None)
            if s is not None:
                self._apply(s.tiers, {})

    def take_snapshot_symbols(self, session_id: str) -> list[str]:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is None or not s.pending_snapshot:
                return []
            out = sorted(s.pending_snapshot)
            s.pending_snapshot.clear()
            return out

    def symbols(self, session_id: str) -> list[str]:
        with self._lock:
            s = self._sessions.get(session_id)
            return s.symbols() if s else []

    def reap(self) -> int:
        with self._lock:
            return self._reap_locked()

    def _reap_locked(self) -> int:
        now = self._clock()
        dead = [
            sid for sid, s in self._sessions.items()
            if s.attached == 0 and s.detached_at is not None and now - s.detached_at >= self.grace_s
        ]
        for sid in dead:
            s = self._sessions.pop(sid)
            self._apply(s.tiers, {})
        return len(dead)

    def stats(self) -> dict:
        with self._lock:
            return {
                "sessions": len(self._sessions),
                "attached": sum(1 for s in self._sessions.values() if s.attached),
                "grace_s": self.grace_s,
            }
