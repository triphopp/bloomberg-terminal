# Bloomberg Terminal

A personal Bloomberg-style financial terminal for local use: cross-asset market data, a
keyboard-driven chart workstation, bond/credit and tail-risk monitors, and a portfolio book with
accounting checks — all in one dark UI backed by a Python data service.

> **Local-only by design.** There is no authentication layer. Do not expose it to the internet.

![Bloomberg Terminal](README.png)

---

## Views

| Key | View | What it shows |
|-----|------|---------------|
| `1` | **MKT** | Watchlist (WATCH / FREQ / ACTIVE feeds), main chart with indicators, REGIME panel (CORR · GEOM · ROT · IV · COT), TICK DATA board (indices, US/JP rates, volatility, FX) |
| `2` | **NEWS** | Per-ticker news from 7 sources grouped by sector, topic feed, social, indicator DATA board, Polymarket column |
| `3` / `b` | **BOND** | MARKET: Treasury and credit legs, corporate issuance (SEC 424B filings) with an event study, Treasury auctions, debt stock, CFTC Treasury-futures positioning · CONDITIONS: crisis level, financial-stress indices, breakevens, mortgage and delinquency data |
| `4` / `p` | **PORT** | PORTFOLIO (positions, options, trades, cash, entry) · ANALYTICS (P&L, TWR growth, XIRR, backtest) · RISK · TOOLS (theses + Zettelkasten, import, audit) · PAPER trading |
| `5` / `t` | **TAIL** | Named market events, 6 risk dimensions → composite, macro context (FOMC/CPI/NFP/PCE/GDP calendar, Fed, curve), sector rotation, CFTC positioning |
| `h` | **HMAP** | One equity market as a sector treemap sized by market cap (`heatmap(US)`, `heatmap(TH, 52w)` …) |

Any symbol opens the **stock view** from global search (`/` or `Ctrl+K`): financials, outlook
(SEC EDGAR), estimates, options, earnings quality, DCF, rate stress, per-symbol regime, and a COT
tab when the symbol maps to a CFTC contract. Views are real links (`?view=bonds`), so they open in
new tabs and survive Back/Forward, and number/letter shortcuts work on a Thai keyboard layout.

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | Next.js 16 (App Router), React 19, TypeScript |
| State | Jotai atoms + TanStack React Query |
| Charts | lightweight-charts (custom `chartkit/`) + Recharts |
| Styling | Tailwind CSS |
| Backend | Python FastAPI — 61 routers in `backend/routers/` |
| Database | SQLite (`backend/portfolio.db`), optional Google Drive JSON sync between machines |
| Market data | yfinance (through a provider registry and an app-wide Yahoo request gate) |
| Macro / rates | FRED, Japan MOF, CBOE volatility CSVs, Treasury fiscaldata |
| Filings / positioning | SEC EDGAR (XBRL, 8-K, EFTS), CFTC Commitments of Traders |
| Other sources | Polymarket, Binance aggTrades, World Bank, BOT and SEC Thailand APIs |
| AI | Claude API (portfolio AI), local Ollama (optional), MCP server for agents |

---

## Requirements

- Python 3.11+
- Node.js 20+
- A free [FRED API key](https://fred.stlouisfed.org/docs/api/api_key.html) — macro, rates, credit and TAIL need it
- Everything else is optional (see [Environment variables](#environment-variables))

---

## Setup

```bash
# backend
cd backend
pip install -r requirements.txt
cp .env.example .env          # add FRED_API_KEY at minimum

# frontend (repo root)
npm install
cp .env.local.example .env.local
```

## Run

| How | Command |
|-----|---------|
| Everything, one command | `npm run dev:all` (backend + frontend + Ollama) or `npm run dev:no-ollama` |
| Windows tray launcher | `BloombergTerminal.exe` in the repo root (build with `tools\launcher\build.bat`; `start.bat` builds it on first run) |
| Two terminals | `cd backend && python -m uvicorn main:app --port 9317 --reload` and `npm run dev` |

The UI opens at **http://bloomberg.localhost:9318** (or `localhost:9318`). The backend listens on
**9317**. The launcher starts both servers hidden, writes `logs\backend.log` / `logs\frontend.log`,
restarts a crashed server and runs the backend with `--reload` by default (`--no-reload` to opt out).
To start it at log-on use `scripts\win\install-startup-task.ps1`.

In `next dev` a strip at the top of the page says **RUNNING OLD CODE** (with a RESTART button) or
**BACKEND DOWN** when the Python server is not the code on disk — check it before debugging a
"missing" route. `GET /api/dev/status` gives the same answer.

**Pulled and nothing changed?** `.env.local` and `backend/.env` are gitignored and an env var always
beats the default in code, so a port or key migration can silently not apply on another machine.
`npm run doctor` reports the drift (it also runs before `dev` and after a pull or branch switch);
`npm run doctor:fix` applies what it can.

---

## Environment variables

`backend/.env` (copy from `backend/.env.example`):

| Variable | Needed for |
|----------|-----------|
| `FRED_API_KEY` | **Required.** Macro, US rates, credit, TAIL, BOND |
| `ANTHROPIC_API_KEY` | Portfolio AI (`CLAUDE_MODEL`, `CLAUDE_MAX_TOKENS` optional) |
| `ALPHA_VANTAGE_API_KEY` | Macro fallback when FRED is unreachable |
| `BINANCE_API_KEY` | Crypto order-footprint indicator (read-only key) |
| `THESES_DIR`, `SOURCES_DIR`, `OBSIDIAN_WIKI_DIR`, `GRAPHS_DIR` | Thesis import/export, Zettelkasten export, analysis pages |
| `CLIPPINGS_DIR`, `OLLAMA_URL` | Backend clippings/Ollama endpoints (no UI since 2026-09-25) |
| `RSSHUB_URL`, `FACEBOOK_ACCESS_TOKEN` | Social feed |
| `BOT_API_TOKEN`, `BOT_IR_TOKEN`, `BOT_FX_TOKEN`, `BOT_STATS_TOKEN` | Bank of Thailand API |
| `SEC2_API_KEY` | SEC Thailand open data (Fund v2, Bond v2, One Report) |
| `SYNC_ENABLED`, `SYNC_DIR`, `SYNC_DEVICE_ID` … | Portfolio cloud sync between two machines |
| `YAHOO_MAX_CONCURRENT` | App-wide cap on in-flight Yahoo requests (default 6) |
| `IV_SNAPSHOT_INTERVAL`, `IV_SNAPSHOT_SYMBOLS` | Background ATM-IV recorder |
| `PORTFOLIO_DB` | Database file (default `portfolio.db`) |

`.env.local`: `PYTHON_API_URL=http://localhost:9317`. Every Next.js proxy imports it from
`lib/constants.ts`.

---

## Project structure

```
bloomberg-terminal/
├── app/api/                  Next.js proxy routes → Python backend (never call Yahoo from here)
├── components/bloomberg/
│   ├── atoms/                Jotai state
│   ├── chart/ · chartkit/    chart engine, indicators, event rail, floating chart windows
│   ├── core/                 global search, shortcuts, backend status banner, shared UI
│   ├── hooks/ · lib/         data hooks, pure helpers (market session, search stats …)
│   ├── layout/               terminal shell, header, view navigation
│   ├── terminal/             command registry (heatmap(US), ALERT …)
│   └── views/                market · news/ · bonds/ · heatmap · portfolio/ · tail/ · stock/
├── backend/
│   ├── main.py               app init + router mounting
│   ├── routers/              61 routers (market, stock, bonds, cot, portfolio_v2, tail_risk …)
│   ├── analytics/            quantitative models (regime, market state, DCF, SVI, payoff …)
│   ├── sources/ · sync/      quote provider registry · cloud sync
│   ├── scripts/              maintenance: backfills, reconciliation, upstream report …
│   ├── tests/                pytest suite
│   └── mcp_server.py         MCP server for agents (docs/mcp-server.md)
├── tools/launcher/           Windows tray launcher (C)
├── scripts/                  env-doctor, icons, install/start scripts
├── docs/                     MCP, regime detection, terminal commands
└── memory/                   project knowledge base for agents (start at memory/INDEX.md)
```

---

## Portfolio book

- **Multi-account, multi-currency** (THB and USD), average-cost (AVCO) lots, options with Greeks,
  dividends, cash ledger with deposits/withdrawals/transfers and reasoned cash corrections.
- **Returns**: time-weighted NAV index (flows removed; capital that arrives on a non-trading day
  counts from the next open), XIRR from trades and from capital, period returns.
- **Portfolio takeover**: lots received in kind are carried at fair value on the transfer date
  (fund practice), with the previous owner's cost kept as a memo — PORT shows the loss before
  takeover, the result since, and the total against the previous cost.
- **Accounting checks** (`GET /api/v2/portfolio/ledger/check`): reconstructed stock cards, cash
  identity, broker statement and execution evidence, audit log of every money edit.

---

## Data health

Every outbound call is observed by `backend/upstream_health.py` and written to
`logs/upstream.jsonl`. When data is missing, stale or slow, read that log first:

```bash
python backend/scripts/upstream_report.py            # last 6h: failures, top targets, stale data
curl -s http://localhost:9317/api/health/upstream     # live state
```

---

## Agent access (MCP)

`backend/mcp_server.py` lets Claude Code / Claude Desktop read and edit investment theses and the
Zettelkasten, and pull the terminal's own portfolio, price, news and filing data over stdio. It talks
to the running backend, so the event log and sync stay identical to the UI. Setup:
[docs/mcp-server.md](docs/mcp-server.md).

---

## Keyboard

| Key | Action |
|-----|--------|
| `1` `2` `3` `4` `5` | MKT · NEWS · BOND · PORT · TAIL |
| `b` `p` `t` `h` | BOND · PORT · TAIL · HMAP |
| `/`, `Ctrl+K` | Global symbol search |
| `i` | Focus the MKT symbol search |
| `y` | %Chg YTD ↔ daily (THB ↔ USD inside PORT) |
| `Alt+1…9` | Tab within the current view |
| `Esc` | Back / close overlay |
| `?` | All shortcuts |

---

## Tests

```bash
cd backend && python -m pytest tests/ -q    # ~1,000 tests
npm run typecheck                             # tsc --noEmit
npm run test:chart                            # chart engine, event rail, regression
npm run test:session                          # market sessions, pure helpers
npm run test:views                            # market state, portfolio helpers
npm run test:alerts                           # alert rule engine
npm run test:watchlist                        # market-data client/proxy
npm run lint                                  # biome
```

A pre-commit hook runs Biome and the type check on staged TypeScript.

---

## Troubleshooting

- **Empty data / search returns nothing** — the backend must be running; check the status strip,
  then `logs/upstream.jsonl`. A mobile hotspot can block or rate-limit Yahoo.
- **Volume Profile greyed out** — calculated indices, yields and FX report zero volume on Yahoo;
  chart a tradeable proxy (`VIXY`, `TLT`, `FXE`).
- **`npm ci` peer-dependency error** — keep `.npmrc` (`legacy-peer-deps=true`).
- **First run shows no symbols** — `symbol_lists` is seeded from `config.py` on backend start;
  check `logs/backend.log`.

---

## Security notes

- No authentication — localhost only.
- `backend/.env`, `.env.local`, `backend/portfolio.db` and `backend/backups/` are gitignored.
- The upstream log never contains URLs with keys; analysis pages render under a strict CSP.

---

## License

MIT — personal/educational use. Not financial advice.
