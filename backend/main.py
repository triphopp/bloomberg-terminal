"""
Market Data API — Python/FastAPI backend
Run: uvicorn main:app --port 8000 --reload
""" # reload trigger
import logging
from datetime import datetime

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("api")

from config import CORS_ORIGINS
from db import init_db, init_portfolio_v2, init_sync_layer, seed_symbol_lists
from analytics.regime_calibration import ensure_model_fresh
from analytics.regime_v2 import ensure_v2_fresh
from analytics.bc_calibration import ensure_calibrated
from routers import market, stock, options, pins, clippings, news, social, macro, global_yields, crisis, sovereign, portfolio, portfolio_v2, backtest_v2, fx, crypto, etf, footprint, central_banks, polymarket, bot, screener, config_router, circuit_breaker, listing_gate, sectors, risk, allocation, country_rotation, sector, sec, sec_v2, regime, rotation, stoploss, alerts, ticker, analytics, fear_greed, tail_risk, paper_trading, providers, sync_router
import sync

app = FastAPI(title="Market Data API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["*"],
)

# ── Initialize database ───────────────────────────────────────────────────────
init_db()
init_portfolio_v2()
init_sync_layer()
seed_symbol_lists()

# ── Cloud sync: pull latest from G: (read cloud first), then start pusher ──────
sync.sync_startup()
sync.start_background_push()

# ── Regime model (trains in background if missing/stale) ──────────────────────
ensure_model_fresh(triggered_by="startup")
ensure_v2_fresh(triggered_by="startup")

# ── BC calibration (runs in background if missing or >90 days old) ────────────
ensure_calibrated(triggered_by="startup")

# ── Mount routers ─────────────────────────────────────────────────────────────
app.include_router(market.router)
app.include_router(stock.router)
app.include_router(options.router)
app.include_router(pins.router)
app.include_router(clippings.router)
app.include_router(news.router)
app.include_router(social.router)
app.include_router(macro.router)
app.include_router(global_yields.router)
app.include_router(crisis.router)
app.include_router(sovereign.router)
app.include_router(portfolio.router)
app.include_router(fx.router)
app.include_router(crypto.router)
app.include_router(etf.router)
app.include_router(footprint.router)
app.include_router(central_banks.router)
app.include_router(polymarket.router)
app.include_router(bot.router)
app.include_router(screener.router)
app.include_router(config_router.router)
app.include_router(circuit_breaker.router)
app.include_router(listing_gate.router)
app.include_router(sectors.router)
app.include_router(portfolio_v2.router)
app.include_router(backtest_v2.router)
app.include_router(risk.router)
app.include_router(allocation.router)
app.include_router(country_rotation.router)
app.include_router(sector.router)
app.include_router(sec.router)
app.include_router(sec_v2.router)
app.include_router(regime.router)
app.include_router(rotation.router)
app.include_router(stoploss.router)
app.include_router(alerts.router)
app.include_router(ticker.router)
app.include_router(analytics.router)
app.include_router(fear_greed.router)
app.include_router(tail_risk.router)
app.include_router(paper_trading.router, tags=["Paper Trading"])
app.include_router(providers.router, tags=["Providers"])
app.include_router(sync_router.router, tags=["Sync"])


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Log 5xx details server-side; return a generic message to the client so
    internal paths / stack info never leak. <500 errors pass through unchanged."""
    if exc.status_code >= 500:
        logger.error("%s %s -> %s: %s", request.method, request.url.path,
                     exc.status_code, exc.detail)
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": "Internal server error"},
            headers=getattr(exc, "headers", None),
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    """Catch-all for uncaught exceptions — log full trace, return generic 500."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


@app.get("/health")
def health():
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}
