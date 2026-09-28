"""One verified TLS context for every `requests` HTTPS pool.

Measured 2026-09-28 (cProfile of a cold /api/tail-risk/signals): 29 calls to
`SSLContext.load_verify_locations` = 11.1 s of CPU — 0.24–0.38 s each on
Windows — more than every computation in that endpoint together. requests'
`HTTPAdapter.cert_verify` sets `pool.ca_certs = <certifi bundle>` and urllib3
then loads the whole bundle into a fresh context on EVERY new connection, and
each `requests.get()` is a new Session → a new pool → a new connection. That
CPU holds the GIL, so the whole server stutters while a cold panel builds.

Fix (what requests 2.32.0 briefly shipped as `_preloaded_ssl_context`): load
the default bundle once, hand that context to pools that verify against the
default bundle, and stop `cert_verify` from re-pointing them at the file.

Safety: urllib3 writes `context.verify_mode = cert_reqs` on the context it is
given, so a shared context must never reach a `verify=False` pool. Only pools
with `verify is True` and no custom bundle get it; `ssl_context` is part of
urllib3's PoolKey, so those pools are never shared with any other kind. A
custom bundle (`verify="path"`, REQUESTS_CA_BUNDLE) keeps requests' own path.
"""

from __future__ import annotations

import ssl
import threading

_ctx: ssl.SSLContext | None = None
_ctx_lock = threading.Lock()


def shared_context() -> ssl.SSLContext:
    global _ctx
    if _ctx is None:
        with _ctx_lock:
            if _ctx is None:
                from requests.utils import DEFAULT_CA_BUNDLE_PATH

                _ctx = ssl.create_default_context(cafile=DEFAULT_CA_BUNDLE_PATH)
    return _ctx


def install() -> bool:
    """Idempotent. False if requests' adapter no longer has the hooks."""
    try:
        from requests.adapters import HTTPAdapter
        from requests.utils import DEFAULT_CA_BUNDLE_PATH
    except Exception:  # pragma: no cover - requests missing
        return False
    orig_build = getattr(HTTPAdapter, "build_connection_pool_key_attributes", None)
    orig_verify = getattr(HTTPAdapter, "cert_verify", None)
    if orig_build is None or orig_verify is None:
        print("[http_tls] not installed: HTTPAdapter hooks not found")
        return False
    if getattr(orig_build, "_shared_tls", False):
        return True

    def build(self, request, verify, cert=None):
        host_params, pool_kwargs = orig_build(self, request, verify, cert)
        if (
            verify is True
            and host_params.get("scheme") == "https"
            and pool_kwargs.get("cert_reqs") == "CERT_REQUIRED"
            and "ca_certs" not in pool_kwargs
            and "ca_cert_dir" not in pool_kwargs
        ):
            pool_kwargs["ssl_context"] = shared_context()
        return host_params, pool_kwargs

    def cert_verify(self, conn, url, verify, cert):
        orig_verify(self, conn, url, verify, cert)
        conn_kw = getattr(conn, "conn_kw", None) or {}
        if (
            verify is True
            and conn_kw.get("ssl_context") is _ctx
            and _ctx is not None
            and getattr(conn, "ca_certs", None) == DEFAULT_CA_BUNDLE_PATH
        ):
            # The shared context already holds exactly this bundle.
            conn.ca_certs = None

    build._shared_tls = True  # type: ignore[attr-defined]
    HTTPAdapter.build_connection_pool_key_attributes = build
    HTTPAdapter.cert_verify = cert_verify
    # Build it now, once, at import: lazily, the first cold burst of threads
    # all queued on the lock behind one ~0.3 s bundle load.
    shared_context()
    return True


INSTALLED = install()
