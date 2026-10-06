"""The backend with auto-reload — `uvicorn --reload`, minus its Windows stall.

    python dev_server.py [--port 9317]

`uvicorn --reload` swaps its worker on Windows by sending it CTRL_C_EVENT and
waiting for it to leave. Started the way the launcher starts it — no console
window, output to a log file — that event reaches the worker late. Measured
2026-10-06 on this backend: the change is seen at 0.3 s, the worker logs
"Shutting down" at 10.6 s and 16.2 s, and until then the OLD code keeps
answering. (Without --timeout-graceful-shutdown it then waited for the quote
stream to close, which never happens, and the backend hung for good.)

This runs the same reloader and the same server with one difference: on
Windows the old worker is terminated, not asked. Nothing is lost by that here —
the lifespan has no shutdown step, SQLite commits are atomic, and a backend
without reload is already restarted with `os._exit` (dev_status.request_restart)
and ended by the launcher's job object. The listening socket belongs to this
process, so a request that arrives during the swap waits for the new worker
instead of being refused.

Elsewhere uvicorn's own restart (SIGTERM) is already prompt and is left alone.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=9317)
    parser.add_argument("--host", default="127.0.0.1")
    # The app to serve, as uvicorn takes it. Only tests point it elsewhere.
    parser.add_argument("--app", default="main:app", help=argparse.SUPPRESS)
    args = parser.parse_args()

    import uvicorn
    from uvicorn._subprocess import get_subprocess
    from uvicorn.supervisors import ChangeReload

    class Reload(ChangeReload):  # WatchFiles when installed, else mtime polling
        def restart(self) -> None:
            if sys.platform != "win32":
                return super().restart()
            self.process.terminate()
            self.process.join()
            self.process = get_subprocess(config=self.config, target=self.target, sockets=self.sockets)
            self.process.start()

    here = Path.cwd().resolve()   # the long form: the watcher reports paths that way
    sys.path.insert(0, str(here))
    # /api/dev/status: a save is "about to be reloaded", not stale code.
    os.environ["BT_BACKEND_RELOAD"] = "1"
    config = uvicorn.Config(
        args.app,
        host=args.host,
        port=args.port,
        reload=True,
        reload_dirs=[str(here)],
        # Not part of the running server: saving a test must not bounce the backend.
        # Absolute — uvicorn tests an exclude against absolute paths — and only
        # folders that exist: it tries a missing one as a glob, which an absolute
        # path is not allowed to be.
        reload_excludes=[str(here / d) for d in ("tests", "scripts") if (here / d).is_dir()],
        # For the stop that IS asked (Ctrl+C in a console): do not wait on open streams.
        timeout_graceful_shutdown=3,
    )
    server = uvicorn.Server(config)
    sock = config.bind_socket()
    Reload(config, target=server.run, sockets=[sock]).run()


# The reload worker is spawned by multiprocessing, which imports this file again.
if __name__ == "__main__":
    main()
