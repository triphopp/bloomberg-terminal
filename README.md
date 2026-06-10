# Bloomberg Terminal

A personal Bloomberg-style financial terminal built for local use. Real-time market data, portfolio management, macro analytics, regime detection, and AI-powered analysis — all in a keyboard-driven dark UI.

> **Local-only by design.** No authentication layer. Do not expose this to the internet without adding auth.

---

## Features

| View | Key | Description |
|------|-----|-------------|
| Market | `1` | Watchlist, interactive chart, regime detection panel (DCC-EWMA correlation) |
| News | `2` | Financial RSS feeds, Facebook social feed, Polymarket prediction markets |
| Market Movers | `3` | Global indices table, sector/commodity/bond heatmap treemap |
| Clippings + AI | `4` | Markdown notes viewer with local Ollama AI (summarize, translate, custom prompt) |
| Macro | `5` | Yield curve, FRED indicators, Fed policy tracker, country comparison, allocation signals |
| Credit | `6` | Credit spreads, stress indicators, consumer credit |
| Portfolio | `P` | Positions, options, trade log, P&L, backtest, VaR/CVaR risk, paper trading |
| Crypto | `C` | 20 coins with order footprint (Binance aggTrades) |
| FX | `E` | 20 currency pairs with chart |

**Analytics:** Stop loss engine (ATR-adaptive + exceedance correlation regime), tail risk signals, DCC-EWMA correlation, sector rotation, country rotation, Fear & Greed index, Black-Scholes Greeks

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16, React 19, TypeScript |
| State | Jotai + TanStack React Query |
| Charts | Recharts + custom candlestick |
| Styling | Tailwind CSS |
| Backend | Python FastAPI (26 routers) |
| Market data | yfinance |
| Macro data | FRED API + Alpha Vantage fallback |
| AI | Local Ollama + Claude API (Anthropic) |
| Prediction markets | Polymarket Gamma API |
| Crypto | Binance aggTrades API |
| Sovereign data | World Bank API |
| Thailand data | Bank of Thailand (BOT) API + SEC Thailand |
| Database | SQLite (`backend/portfolio.db`) |
| Options | Black-Scholes + Gram-Charlier correction |

---

## Requirements

- **Python 3.11+**
- **Node.js 20+**
- **FRED API key** (free) — required for macro data
- Other keys optional (see [Environment Variables](#environment-variables))

---

## Setup

### 1. Clone

```bash
git clone https://github.com/YOUR_USERNAME/bloomberg-terminal.git
cd bloomberg-terminal
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
# Edit .env — add FRED_API_KEY at minimum
```

### 3. Frontend

```bash
# from project root
npm install
cp .env.local.example .env.local
# PYTHON_API_URL=http://localhost:8000  (already set)
```

### 4. Run

```bash
# Terminal 1 — backend
cd backend
python -m uvicorn main:app --port 8000 --reload

# Terminal 2 — frontend
npm run dev
# → http://localhost:3000
```

**Windows one-click:** `start.ps1` or `start.bat` launches both in separate windows.

---

## Environment Variables

Copy `backend/.env.example` → `backend/.env`. Only `FRED_API_KEY` is required.

| Variable | Required | Description |
|----------|----------|-------------|
| `FRED_API_KEY` | **Yes** | [Get free key](https://fred.stlouisfed.org/docs/api/api_key.html) — macro indicators |
| `ANTHROPIC_API_KEY` | No | [console.anthropic.com](https://console.anthropic.com) — portfolio AI chat |
| `ALPHA_VANTAGE_API_KEY` | No | Macro data fallback |
| `BINANCE_API_KEY` | No | Read-only — crypto order footprint |
| `OLLAMA_URL` | No | Default `http://localhost:11434` — local AI for notes |
| `CLIPPINGS_DIR` | No | Path to your markdown notes folder |
| `THESES_DIR` | No | Path to investment theses folder |
| `FACEBOOK_ACCESS_TOKEN` | No | Facebook Graph API — social news feed |
| `BOT_API_TOKEN` | No | [apportal.bot.or.th](https://apportal.bot.or.th) — Bank of Thailand |
| `SEC2_API_KEY` | No | [secopendata.sec.or.th](https://secopendata.sec.or.th) — SEC Thailand |

Frontend (`.env.local`):
```
PYTHON_API_URL=http://localhost:8000
```

---

## Project Structure

```
bloomberg-terminal/
├── backend/
│   ├── main.py              # FastAPI app init + router mounter
│   ├── config.py            # Constants, indices, env vars
│   ├── db.py                # SQLite schema + helpers
│   ├── greeks.py            # Black-Scholes + Gram-Charlier
│   ├── routers/             # 26 modular routers
│   │   ├── market.py        # Market data + heatmap
│   │   ├── stock.py         # Quotes, history, dividends, earnings
│   │   ├── portfolio_v2.py  # Portfolio CRUD (accounts, trades, dividends)
│   │   ├── risk.py          # VaR, CVaR, stress test, risk parity
│   │   ├── stoploss.py      # ATR-adaptive stop loss + regime
│   │   ├── macro.py         # FRED macro indicators
│   │   ├── paper_trading.py # Paper trading engine
│   │   └── ...              # 19 more routers
│   ├── analytics/           # Quantitative models
│   │   ├── dcc_ewma.py      # DCC-EWMA correlation (Engle 2002)
│   │   └── regime_calibration.py
│   └── .env.example
├── app/
│   └── api/                 # Next.js proxy routes → Python backend
├── components/bloomberg/
│   ├── atoms/               # Jotai state atoms
│   ├── hooks/               # useTerminalUI, useMarketData, ...
│   ├── layout/              # Terminal shell, header, navigation
│   └── views/               # 9 view components + portfolio tabs
└── memory/reference/        # Architecture docs, API reference, data shapes
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`6`, `P`, `C`, `E` | Switch view |
| `/` | Global symbol search |
| `Alt+1`–`Alt+7` | Switch tab within current view |
| `Esc` | Close modal / search |

---

## Stop Loss Engine

Adaptive stop loss using ATR (Wilder 1978) with exceedance correlation regime detection (Longin & Solnik 2001):

- **ATR period** adapts to VIX percentile (10–30 bars)
- **Regime** classified from Spearman correlation on tail returns across SPY/TLT/GLD/BTC
- **Regimes:** CRISIS (1.5×) → RISK-OFF (2.0×) → TRENDING (2.5×) → DIVERGENT (3.0×)
- **Stop** = `Price − ATR × dynamic_multiplier − ATR × buffer`

```
GET /api/stoploss/compute?symbols=AAPL,TSLA
GET /api/stoploss/regime
GET /api/stoploss/atr?symbols=SPY
```

---

## Quantitative Models

| Model | File | Reference |
|-------|------|-----------|
| DCC-EWMA correlation | `analytics/dcc_ewma.py` | Engle (2002) |
| HMM regime (4-state) | `analytics/regime_hmm.py` | Trained locally |
| Exceedance correlation regime | `routers/stoploss.py` | Longin & Solnik (2001) |
| Black-Scholes + Gram-Charlier | `greeks.py` | BSM |
| Ledoit-Wolf covariance | `routers/risk.py` | Ledoit & Wolf (2004) |
| VaR / CVaR | `routers/risk.py` | Historical + Parametric |

---

## Tests

```bash
cd backend
python -m pytest tests/ -v   # 58 unit tests (Greeks, SEC endpoints)

npx tsc --noEmit              # TypeScript type check
```

---

## Security Notes

- **No authentication** — designed for localhost only
- `backend/.env` and `backend/portfolio.db` are gitignored — never commit these
- Clippings directory is path-validated against a whitelist (no path traversal)
- Trade symbols are sanitized before any filesystem writes
- All 500 errors return generic messages (no internal paths or stack traces exposed)

---

## License

MIT — personal/educational use. Not financial advice.
