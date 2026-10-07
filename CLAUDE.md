# Bloomberg Terminal — Claude Instructions

> **Start every session by reading [`memory/project_summary.md`](memory/project_summary.md)**
> It contains the full picture: features, architecture, all key files, env vars, run commands, and known issues.

## Quick reference

```bash
# Backend (Terminal 1) — macOS/Linux
cd backend
# env vars are in backend/.env — loaded automatically by python-dotenv
python -m uvicorn main:app --port 9317 --reload --timeout-graceful-shutdown 3

# Backend (Terminal 1) — Windows PowerShell
cd backend
python dev_server.py --port 9317     # uvicorn --reload, minus its 10-20 s stall on Windows

# Frontend (Terminal 2)
npm run dev   # → http://bloomberg.localhost:9318 (or localhost:9318)
```

**Windows one-click / start-up:** `BloombergTerminal.exe` (repo root) — native tray
launcher, starts both servers hidden, logs to `logs\`, kills them on quit.
Build with `tools\launcher\build.bat`; `start.bat` builds it on first run.
Details + flags: `tools/launcher/README.md`. Auto-start at log-on:
`scripts\win\install-startup-task.ps1` (scheduled task, 30s delay, restarts the
launcher if it dies) or the tray's "Run at Windows start-up" (`HKCU\...\Run`) —
never a copy of the exe in `shell:startup`. The launcher also restarts a dead
backend/frontend by itself (3 tries, budget resets when healthy). **Backend auto-reloads
by default** (`--no-reload` to opt out) through `backend/dev_server.py`, not `uvicorn --reload`: on Windows uvicorn swaps
its worker with a console Ctrl-C that reaches a windowless process 10–20 s late (and, before `--timeout-graceful-shutdown`,
then hung on the quote stream for good). A save is live in ~6 s — the app's own start-up. `--local-only` binds the
frontend to this machine (default: the LAN can open it, which is how a phone does); in `next dev` a strip at the top says
RUNNING OLD CODE (+ RESTART button) or BACKEND DOWN (→ `logs\backend.log`) — read it
before debugging a "missing" route or field (`GET /api/dev/status`). Icons (exe + browser favicon)
มาจาก `npm run icons` (`scripts/gen-icons.mjs`) แหล่งเดียว. Per-server debug windows live in
`scripts\win\`.

## Ports

Backend **9317**, frontend **9318** (off the crowded 3000/8000 pair). The UI opens at
`http://bloomberg.localhost:9318` — browsers map `*.localhost` to loopback themselves, so it
needs no hosts entry or cert (a `.dev` name would be forced to HTTPS by Chrome's HSTS preload). Changing them
touches three places and nothing else:
1. `.env.local` → `PYTHON_API_URL`
2. `backend/.env` → `CORS_ORIGINS`
3. whatever starts the servers — `BloombergTerminal.exe --backend-port N --frontend-port N`,
   or `BACKEND_PORT` / `FRONTEND_PORT` for the `dev:all` / `dev:no-ollama` npm scripts.

Every `app/api/**` proxy imports `PYTHON_API` from `lib/constants.ts` — never
re-declare it, and never `fetch("http://localhost:<port>")` from a component.

### env-doctor — the drift check

`.env.local` and `backend/.env` are gitignored, so they never travel with a
`git pull`. A port migration lands in the tracked code on one machine and does
nothing on the other, because the env var beats the default in the source. The
symptom is "I pulled and nothing changed" — the 8000/3000 → 9317/9318 move hit
exactly this on macOS.

```bash
npm run doctor      # report (also runs as predev, warn-only)
npm run doctor:fix  # create missing files, add missing keys, rewrite stale ports
npm run doctor:ci   # exit 1 on any finding
```

`scripts/env-doctor.mjs` reads the ports out of `package.json` (the thing that
actually launches the servers) and checks them against `.env.local`,
`backend/.env`, `lib/constants.ts` and `backend/config.py`, plus any
`BACKEND_PORT` / `FRONTEND_PORT` / `PYTHON_API_URL` exported in the shell — those
silently outrank every file. `.husky/post-merge` and `post-checkout` run it after
a pull or a branch switch. It prints key *names* only, never values, and `--fix`
never deletes a key.

## Data missing / stale / slow / "network dropped" → read the upstream log FIRST

Every outbound call (Yahoo via yfinance, FRED/CBOE/CNN/SEC/Polymarket/… via
`requests`) is observed by `backend/upstream_health.py` and written to
**`logs/upstream.jsonl`** (JSON lines, rotated to `.1` at 5 MB). There is no
in-app alert — this log is where problems are recorded, and agents check it.

```bash
python backend/scripts/upstream_report.py              # last 6h: failures, top targets, status changes, stale data, volume
python backend/scripts/upstream_report.py --hours 24 --source FRED
python backend/scripts/upstream_report.py --events fail retry --raw
curl -s http://localhost:9317/api/health/upstream      # live state (answered from memory, no outbound call)
```

How to read it:
- **One `target` dominating the failures** = a dead or slow series, not an outage
  (2026-09-24: every "FRED timeout" was one deleted series, `BAMLHE00EHY0D`, retried every ~70s).
  Fix the caller; add a negative cache.
- **`network` event / `dns` failures on 2+ sources** = the machine's connection, not a vendor.
- **`rate_limit` on Yahoo** = too many requests; check `summary` volume (`calls/min`).
- **`stale` without a matching `fresh`** = a panel is still serving an old pull.
- Retries are already automatic for FRED GETs (2×, backoff); `fail` means retries were exhausted.
- The log never contains URLs or API keys — keep it that way (`upstream_health.target_of`).

New fetch code: use `requests` or yfinance so it is observed automatically; any other
client must call `upstream_health.record(source, kind, target=…)`. Failed fetches must
be negative-cached, or "empty = expired" re-fires them on every request.

## Rules
- Never fetch Yahoo Finance directly from Next.js — always go through the Python backend
- Never reintroduce `@upstash/redis`, `yahoo-finance2`, or any top-level scheduler singleton
- Backend is modular: `main.py` (app init) + `config.py` + `db.py` + `routers/*.py`
- State lives in Jotai atoms (`components/bloomberg/atoms/index.ts`) + React Query for server data
- Native `<select>` menus must use the app-wide popup palette in `styles/globals.css` (`color-scheme` plus explicit `<option>` foreground/background, with light/forced-colors variants). Do not style only the closed select with light text on a transparent background: Windows can render its popup with a light system background. Verify new selectors in DCF/IV-style panels on Windows and Mac when available.

## ASK — one chat module (2026-10-06)

All chat-with-the-model code is `components/bloomberg/ask/` (public API in `index.ts`). `<AskDock />` in the shell
gives **every** view the drawer (header icon / `c`) — a new view needs no code. Optional, one line each:
`useAskContext({ symbols, note })` (what the page shows; the view name is sent automatically) ·
`<AskBar />` + `<AskColumn />` (conversation as a column of the view, as NEWS does; `useAskColumnShown()` to make room).
Never copy ASK state or UI into a view, never branch on the view name to place it, never call `/api/news/ask` outside
`ask/` (`ASK_API`). Backend: `routers/news_ai.py`. Pictures: paste / drop / attach icon, ≤4 per question, scaled in
the browser (`ask/images.ts`), sent as data URLs — the backend never fetches an image link. The agent reads the
page it was asked from: `read_screen` = the view's text as displayed (`ask/screen.ts`, every view, PORT included — it
goes to the model provider when read), then `get_page_data` = one section of the data behind a view, only when the
screen lacks it. **New view with data worth asking about → add its sections to `PAGES` in `backend/ask_pages.py`**
(path + one-line description; the description is prompt text). **A button that switches something — a tab, a range,
a mode, a show/hide — carries `aria-pressed={<the same condition that colours it>}`**: colour does not reach the
agent, the attribute does (`▶` in the screen text). 154 places carry it (2026-10-06); a new toggle without it is
invisible to ASK. ASK also reads theses, open questions, tracked numbers, zettel and company accounts (`backend/ask_research.py`) —
**read-only by design: never give ASK a tool that writes.** Writing research goes through the MCP and its rules.
A new ASK tool that returns the user's own data goes in `_PRIVATE_TOOLS` (`routers/news_ai.py`): after one runs,
`read_page` opens only links a tool returned or the user typed — that is what stops a news story from talking the model
into sending the portfolio somewhere. `npm run test:ask`. The conversation on screen survives a reload in `sessionStorage`
(this tab), and every conversation is saved as a file for ASK → HISTORY (a tab of the ASK column beside CHAT: grouped by day, filter, ★ pin kept in the file, ✕ delete → TRASH (restore, or erase for good — only from the trash); an empty chat lists RECENT CHATS; the dashed-bubble icon = temporary chat, `askTemporaryAtom`: kept in memory only — no file, no `sessionStorage`, gone on NEW / reload; switched off mid-chat it becomes a saved one) — **outside the repository, where each machine
decides**: the Google Drive folder the portfolio syncs through (`<SYNC_DIR>/ask-sessions`) or the user's app-data folder
(`backend/ask_sessions.py`; `ASK_SESSIONS_STORE` / `ASK_SESSIONS_DIR` in `backend/.env`, set from HISTORY → STORAGE or
`python scripts/ask_sessions.py`). A folder inside the repo is refused — conversations hold portfolio data and must not be
one `git add .` from a commit. Each question shows when it was asked: an answer is a reading of that moment; the latest pictures
travel with the next 3 exchanges; a conversation opened again from HISTORY is told when each question was asked and, after
≥6 h, that its figures are old; exchanges past the 12-turn window go as one-line digests; `search_sessions` / `read_session`
let ASK read other saved conversations (private tools, their links never unlock `read_page`); `get_page_data` has sections for all seven views (`key` = ticker / market code).

## Writes to `/api/**` — same origin only (2026-10-06)

`proxy.ts` (Next 16's middleware) refuses every non-GET request to `/api/**` that did not come from this app's own page
(`lib/request-origin.ts`: `Sec-Fetch-Site`, `Origin` = `Host`, host is local or in `DEV_ORIGINS`). The route handlers
relabel any body as JSON and the backend sees the proxy as a local caller, so without it another site open in the same
browser could book a trade with a plain form. A new route is covered automatically — do not add a way around it.

## Number format (house rule, 2026-09-26)

| What | Decimals | Helper |
|------|----------|--------|
| Any displayed **price**, whole app | **min 2**, never rounded to a whole number however large (51,828.60 not 51,829); below 1 → up to 4 | `lib/number-format.ts` `fmtPriceStd` |
| PORT **trade prices** — entry, exit, current, target, S/L, strike, premium | **2–4** | `views/portfolio/helpers.ts` `fmtPx` |
| PORT **volume / quantity** | **up to 7**, none when whole (3,000 · 0.0012345 · 27.295) | `fmtQty` |
| PORT **money** — cost, MV, NAV, P&L, cash | exactly 2, no K/M | `fmtAmt` |

- K/M/B suffixes only on chart **axis ticks** (`fmtAxis`) — never on a value a person reads as a price or amount.
- Never `toLocaleString()` bare on a quantity (stops at 3 dp) or `maximumFractionDigits: 0` / `toFixed(0|1)` on a price.
- New price display → use the helper; don't write another local `fmtPrice`.
- Typed number fields (PORT ENTRY / CASH / SELL / RECONCILE) → `views/portfolio/ui/NumInput.tsx`, not `<input type="number">`: shows `1,234,567.89` while typing, hands the form `1234567.89`, never rounds (logic in `components/bloomberg/lib/number-input.ts`). No minus unless `allowNegative`.

## Chart indicators — performance rules (2026-09-26)

`compute()` runs on every live tick over the whole loaded history. Rules are in the header of
`components/bloomberg/chart/indicators/index.ts` and enforced by `chart/__tests__/indicator-rules.test.ts`
(part of `npm run test:chart`): window statistics go through `chart/rolling.ts` (never re-slice / re-sort /
re-loop the last k bars per bar), no `Math.max(...arr)`, no `shift()` in loops, expensive fits cached on
closed-bar content (not array identity). Exceptions need `// perf-ok: <reason>`. Same rules for
`lib/volume-stats.ts`, `lib/volume-events.ts`, `lib/bb-volume.ts`.

## Looking for data → `memory/reference/data-sources.md` FIRST (2026-09-29)

Before searching for any data (macro, country, rates, company, news), open
**[`memory/reference/data-sources.md`](memory/reference/data-sources.md)** and go in its order:
MCP tools → backend endpoints that already exist → the verified free APIs listed there
(IMF SDMX, World Bank, BIS, OECD, BOT, …) → only then the web. A new source that works
goes back into that file. The MCP serves the same file (`get_data_sources` tool ·
`spec://data-sources`) — edit the file, not the MCP.

## Open questions — PORT → TOOLS → QUESTIONS (2026-10-01)

What a thesis does not know yet is a row in `questions`, not a paragraph in the thesis body. To answer one,
follow **[`memory/reference/question-research.md`](memory/reference/question-research.md)**: competing
explanations first, then the signals each would leave, then the search. The server (`routers/questions.py`)
takes a question with only its text (what is missing to place it comes back as `gaps`) but
refuses an answer without evidence and lists what is missing; inference needs a testable assumption; only the
user accepts an answer or drops a question. Status and the badge numbers are derived on read — never add a
status column. The same file is served over MCP (`get_question_spec` · `spec://question-research` ·
`investigate_questions` prompt). A whole tree goes in through `POST /api/v2/questions/import` (MCP
`question_import`) — never a per-thesis seed script. **New `question*` rows must not be written until every machine runs this
code** — a peer on old code drops ops for tables it does not know (`gotchas.md`).

## Tracked numbers — PORT → TOOLS → TRACK (2026-10-02)

A number a thesis stands or falls on — a kill condition, a margin, an inventory figure, a contract price — is a row
in `track_metrics`, not a line under `## Condition Killers`. Follow
**[`memory/reference/thesis-tracking.md`](memory/reference/thesis-tracking.md)**: the row says where the number is
read (source name, link, place in the document, the tool that fetches it), each period gets a forecast with its
reason and release date, and when the date comes the number is recorded with evidence. The server
(`routers/tracking.py`) decides the verdict when the forecast is a band, refuses a forecast written after the
result, and opens a `questions` row when a number misses or crosses its kill line — that question is answered by the
question protocol above. Only the user moves a kill line that is set, changes a role, or retires a metric; crossing a
kill line never changes the thesis by itself. Status is derived on read — never add a status column, and never
UPDATE a forecast or a reading (a revision or correction is a new row). The release date is a row of the question
calendar (`question_dates`) — do not build a second calendar. Served over MCP: `get_tracking_spec` ·
`spec://thesis-tracking` · tools `track_*`. **New `track_*` rows must not be written until every machine runs this
code** (same reason as `question*`).

## Fundamental analysis — "วิเคราะห์พื้นฐาน [ticker]" (2026-09-27)

When the user asks for a fundamental analysis (วิเคราะห์พื้นฐาน) of a stock, follow
**[`memory/reference/fundamental-analysis.md`](memory/reference/fundamental-analysis.md)** exactly:
which data to pull (MCP `get_stock_data` kinds, `get_filings` 10-K/20-F, earnings call, `get_news`),
the 12-section Thai beginner report, and the rules — facts only, say "ไม่ชัด" when unclear, latest numbers first.
The same file is served over MCP (`get_fundamental_spec` tool · `fundamental_analysis` prompt ·
`spec://fundamental-analysis` resource) so agents outside the repo follow it too — edit the file, not the MCP.

## Memory Maintenance — What to Update After Each Change

| Changed | อัปเดตไฟล์เหล่านี้ |
|---------|-------------------|
| เพิ่ม router ใหม่ | `project_summary.md` (routers table) + `reference/api-endpoints.md` + `reference/architecture.md` |
| เพิ่ม endpoint ใหม่ | `reference/api-endpoints.md` + `reference/data-shapes.md` (ถ้า shape ใหม่) |
| เปลี่ยน response shape | `reference/data-shapes.md` ⚠️ อย่าลืม — frontend hardcode field names |
| เพิ่ม view ใหม่ | `project_summary.md` (views table) + `CLAUDE.md` (views table) + `reference/frontend-structure.md` |
| เพิ่ม component / hook | `reference/frontend-structure.md` (exports table) |
| เพิ่ม TypeScript interface | `reference/data-shapes.md` + `reference/frontend-structure.md` (exports) |
| เพิ่ม env var | `project_summary.md` (env vars) + `reference/gotchas.md` (env var → feature map) |
| เพิ่ม DB table | `project_summary.md` (SQLite schema) + `reference/data-shapes.md` |
| แก้ bug ที่เป็น pattern | `reference/gotchas.md` (เพิ่ม error + fix) |
| เพิ่ม analytics module | `reference/architecture.md` (analytics folder section) |

**Before investigating a bug:** อ่าน `reference/gotchas.md` ก่อน — อาจเคยเจอแล้ว

## Pattern Cookbook

### Add a new backend endpoint
1. Create/edit `backend/routers/X.py` — define `router = APIRouter()`
2. Mount in `backend/main.py` — `app.include_router(x_router, tags=["X"])`
3. Create Next.js proxy `app/api/X/route.ts` — fetch `${PYTHON_API}/api/X`
4. Update `memory/reference/api-endpoints.md` + `memory/project_summary.md` routers table

### Add a new frontend view
1. `atoms/index.ts` — add string literal to view atom union
2. `hooks/useTerminalUI.ts` — add keyboard handler case
3. `layout/bloomberg-terminal.tsx` — add `{currentView === "X" && <XView />}` block
4. `layout/terminal-header.tsx` — add nav button
5. Update `memory/reference/frontend-structure.md` + `memory/project_summary.md` views table

### Add a new tab inside a tabbed view (bonds, portfolio, …)
1. Create `views/X-tab.tsx` — component with `h-full flex flex-col overflow-hidden` root
2. Import + add to tab array in parent view
3. Wire `Alt+N` shortcut in `terminal-layout.tsx` if needed

### Add a new portfolio tab
1. Create `views/portfolio/tabs/XTab.tsx`
2. Add to `tabList` array in `views/portfolio/index.tsx`
3. Types go in `portfolio/types.ts`, constants in `portfolio/constants.ts`, helpers in `portfolio/helpers.ts`

### localStorage persistence (React — correct pattern)
```tsx
// READ in useState initializer (not useEffect — fires too late)
const [val, setVal] = useState<T>(() => {
  if (typeof window === "undefined") return DEFAULT;
  try {
    const s = localStorage.getItem("key");
    if (s) return JSON.parse(s) as T;
  } catch { /* ignore */ }
  return DEFAULT;
});
// WRITE in useEffect keyed on the value
useEffect(() => { localStorage.setItem("key", JSON.stringify(val)); }, [val]);
// Side-effects: call setVal directly in handlers — NOT through a state-watching effect
```
Never use `useEffect([dense])` to reset cols — it fires on mount and overwrites loaded state.

### Scrollable section inside fixed-height container
```tsx
// Parent must be h-full flex flex-col
<div className="flex flex-col h-full">
  <div className="shrink-0">header / tabs</div>
  <div className="flex-1 overflow-y-auto">scrollable content</div>
</div>
```
Without `h-full` on root or `shrink-0` on header, content gets clipped by parent `overflow-hidden`.

### React Query data fetch (standard pattern)
```tsx
const { data, isLoading, error } = useQuery({
  queryKey: ["X", param],
  queryFn: () => fetch(`/api/X?param=${param}`).then(r => r.json()),
  staleTime: 60_000,
});
```

### SQLite schema update
Add table in `backend/db.py` → `init_db()` function. Use `IF NOT EXISTS`. Run via `get_db()` context manager. Never alter production columns directly — add new columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

### Caching in a new router
```python
from cache import TTLCache
_cache = TTLCache()

@router.get("/api/X")
async def get_x():
    cached = _cache.get("x")
    if cached: return cached
    data = await fetch_data()
    _cache.set("x", data, ttl=300)
    return data
```

## Views (6 views — BOND added, CLIP removed, CRDT merged into BOND 2026-09-25)

| Key | Button | View | Content |
|-----|--------|------|---------|
| `1` | MKT   | market-view    | Watchlist · Chart · TICK DATA board (indices · RATES·US · RATES·JP · VOLATILITY · FX; ▼p/▲p CFTC crowding mark on flagged rows) · REGIME panel modes CORR/GEOM/ROT/IV/**COT** (positioning PC1) |
| `2` | NEWS  | news-view → `views/news/` | **ASK** bar above every tab (question → DeepSeek with read-only terminal tools + news search + page reading, `/api/news/ask`, needs `DEEPSEEK_API_KEY`; general web search with `TAVILY_API_KEY`/`BRAVE_API_KEY`) · WATCHLIST tab (ข่าวรายหุ้นจาก watchlist, 7 แหล่ง, แบ่งตาม SECTOR) · NEWSFEED (topic) · SOCIAL · Polymarket column (right 256px: watchlist markets + macro signals) |
| `h` / `heatmap(MKT)` | HMAP (no nav button) | `views/heatmap-view.tsx` | One equity market as a sector-grouped treemap sized by market cap (~275 names, 25/sector). Command `heatmap(TH)`, `heatmap(US, 52w)`, bare `HMAP` = last market; `h` reopens it. Metrics 1D · 52W · 50D · 200D · HIGH · RVOL switch with no request; sector strip = zoom; hover line = all metrics; click → equity, shift-click → chart window. `/api/market-heatmap` (`routers/market_heatmap.py`, Yahoo screener, 11 parallel sector calls, 90s cache + last-good) |
| `5` / `t` | TAIL  | tail-risk-view | MARKET EVENTS (named: Rates Volatility Shock, Treasury Selloff — Bear Flattening … from z of 1d/5d changes; SEVERE raises composite; ribbon shows top 2) + 6 risk dimensions (composite) + MACRO CONTEXT (not in composite): event strip FOMC/SEP/CPI/NFP/PCE/GDP + EVENT WINDOW tag on VIX signals, Fed rate/stance, 10Y−2Y/10Y−3M, regime, latest prints, event markers on 90D chart · MACRO READ (inflation/growth/rates-vol) · SECTOR ROTATION (turnover tilt, ไม่ใช่ fund flow) · **POSITIONING** (CFTC COT crowding flags + table; `cot_crowding` signal shown with CTX tag, `counted: False`, backtest WEAK) · **BUSINESS CYCLE** (`/api/cycle`, `backend/cycle.py`): official indicators read by their publishers' definitions — NBER, Sahm, recession probability, CFNAI, GDP-based index, yield-curve probit, OECD CLI, CBO gaps, PCE vs 2%, policy vs SEP longer-run / Taylor 1993, NFCI — each row opens to the rule, source and track record; WHAT FOLLOWS = ควรรู้ / ควรทำ / ไม่ควรทำ. No composite, no phase of our own, never a sector call (tested DEAD) |
| `3` / `b` | BOND  | `views/bonds/` | 2 tabs (Alt+1/2). **MARKET** — price vs supply: KPI strip · **10Y YIELD DECOMPOSITION** (expected real + breakeven + term premium via NY Fed ACM; 20D driver REAL/TP/BE; Δ attribution 1/5/20/60D; tripwires TP>10y high · BE≥2.5→20y high · 10Y 5.5%; `/api/bonds/decomposition`, `backend/bond_decomposition.py`) · TREASURY LEG (2/10/30Y, real, term premium) · CREDIT LEG (IG/HY OAS, Baa−Aaa, BBB yield) · CORPORATE ISSUANCE/WEEK = SEC EFTS 424B2/424B5 deals ex-bank (SIC-classified, 365d backfill into SQLite) + EVENT STUDY (heavy days vs rest, Δ10Y/ΔIG OAS t..t+3) + RECENT DEALS · TREASURY AUCTIONS (fiscaldata) · DEBT STOCK (Z.1, C&I, SLOOS). Counts deals, not $ — no free daily $ source. **CONDITIONS** (ex-CRDT, `/api/crisis`) — crisis level L0–3 (also in status bar) · STL FSI/NFCI · 5Y/10Y breakeven · 30Y mortgage · CC/mortgage delinquency. IG/HY trigger lines (2%/5%) on CREDIT LEG. **CFTC** (`/api/cot/basis`): TREASURY FUTURES POSITIONING · BASIS TRADE (MARKET, DV01 10Y-eq) + DEALER BALANCE SHEET (CONDITIONS) |
| `4` / `p` | PORT  | portfolio-view | 4 top-level: PORTFOLIO (sub: POSITIONS·OPTIONS·TRADES·CASH·ENTRY) · ANALYTICS (P&L, no sub strip) · RISK (6 pages: สรุป = one look — plain-words risk, down-tilted paths 3/5/7/21/42 days, margin, TRADE GUARD, decision journal, then the methods (ex-เชิงลึก) · REBALANCE (+ "ยังไม่ขาย" with a reason) · BUDGET · FACTOR · WHAT-IF · MONTE CARLO · ขาลง · OPTIONS; a `guard:REBALANCE` alert links straight to REBALANCE via `useOpenRisk`) · TOOLS (sub: THESES·QUESTIONS·TRACK·IMPORT·AUDIT — the first three share one thesis navigator + read marks, set in `.reading` type; THESES → RESEARCH is the ex-GRAPHS tab) |

**TICK DATA board** (MKT right panel): 7 built-in collapsible sections — AMERICAS · EMEA · ASIA PACIFIC (`/api/market-data`, 6 incl. KOSPI) · RATES·US (11 UST tenors, FRED daily) · RATES·JP (15 JGB tenors, MOF CSV) · VOLATILITY (20 VIX-family incl. MOVE, `/api/volatility`, sub-grouped S&P TERM / VOL OF VOL / EQUITY / GLOBAL / COMMOD·RATES) · FX (`/api/fx`) — **plus the user's own sections** (2026-10-07): ✎ in the header = EDIT — add a section, put any quoted symbol in it (`/api/tick-custom`), rename / reorder / delete, and HIDE / SHOW any built-in row or section. All of that is `components/bloomberg/lib/tick-board.ts` (pure, tested) + `localStorage["bloomberg_tickdata_custom"]`, per browser; a never-edited board shows MY LIST = IXG. **A new built-in row goes in `backend/config.py`; never hard-code a user's symbol into the board.** Collapse state in `localStorage["bloomberg_tickdata_sections"]`. ▲/▼ tally counts indices + FX only — a green VIX is a bad day, and a rising yield is a falling bond, so neither belongs in it. แถบบนสุดของ board = `UsMarketClock` (นาฬิกา ET + phase PRE/OPEN/AFTER/CLOSED + timeline + นับถอยหลัง). **ตลาดสหรัฐไม่มีพักกลางวัน** — เทรดต่อเนื่อง 09:30–16:00 ET (ที่พักเที่ยงคือ SET 12:30–14:30, TSE 11:30–12:30, HKEX 12:00–13:00). Logic อยู่ใน `components/bloomberg/lib/us-market-session.ts` (pure, test ได้) — วันหยุด NYSE + half-day 13:00 ET hardcode ถึงปี 2027 เท่านั้น เกินนั้น widget ขึ้นเตือนตัวเอง. Yield rows show bp, not %chg, and only 4 tenors (`^IRX ^FVX ^TNX ^TYX`) can drive the chart.

**PAPER + ANALYTICS → BACKTEST removed 2026-10-02** — tabs `Paper*Tab.tsx`, `BacktestTab.tsx` and proxies `app/api/paper/*`, `app/api/v2/portfolio/backtest/*` deleted. **Backend `paper_trading.py` + `backtest_v2.py` stay** (no UI consumer; `margin.py` still imports paper valuation). MGN ribbon skips paper accounts.  
**GMOV `3` removed 2026-09-25** — replaced by HMAP (above). `views/market-movers-view.tsx` deleted; its global-indices table lives on in MKT TICK DATA. **Backend `/api/heatmap*` endpoints + `app/api/heatmap/*` proxies stay** (no UI consumer now).  
**Removed:** GVOL (fake `Math.random()` data), EQTY (duplicates MKT search), RMI (removed 2026-05-24), CRYP `C` + FX `E` (2026-08-01 — FX folded into the TICK DATA board; crypto via global search `BTC-USD` → stock-view, which also has Order Footprint. **Backend `crypto.py`/`fx.py` routers stay** — `/api/crypto/footprint` powers that indicator). Keys `C` and `E` are now free.  
**Stock analysis** (9 tabs: financials, options, etc.) still accessible from global search / heatmap click — plus a **COT** tab when the symbol maps to a CFTC contract (ES=F/SPY, ^VIX, JPY=X, BTC-USD, CL=F, GC=F, ^TNX …). PORT → RISK shows FUTURES POSITIONING vs BOOK (`/api/cot/portfolio`). All COT surfaces are weekly context (as of Tue, released Fri) — `backend/routers/cot.py`  
**CRDT `6` merged into BOND 2026-09-25** — `views/credit-view.tsx` deleted; overlap dropped (HY/IG OAS + curve = BOND MARKET, VIX = TAIL, TED spread = dead since 2022-01); the rest is BOND → CONDITIONS via `useCreditData(isActive)`. **Backend `crisis.py` stays** (TAIL + `/api/crisis/composite`). Key `6` is free.  
**CLIP removed 2026-09-25** (was `4`). Keys renumbered 2026-09-26: `1` MKT · `2` NEWS · `3`/`b` BOND · `4`/`p` PORT · `5`/`t` TAIL · `h` HMAP. `views/clippings-view.tsx` + `app/api/clippings/*` deleted; **backend `clippings.py` router stays** (Obsidian/Ollama endpoints, no UI consumer).  
**MACRO `5` removed 2026-09-17** — US macro (Fed, curve, indicators, regime) + FOMC/release calendar moved into TAIL as context; COUNTRY (World Bank) and SIGNALS (country rotation / sector selection / allocation) tabs were deleted with it. Backend routers remain (`/api/macro`, `/api/sovereign/*`, `/api/country-rotation`, `/api/sector`, `/api/allocation`) — TAIL reads `/api/macro` in-process. Key `5` now opens TAIL (renumbered 2026-09-26).

## 3 Mandatory Rules (ALL agents, every session)

**Rule 1 — Plan created:**
สร้าง `memory/plans/<name>.md` → เพิ่ม `- [ ] **Feature** — desc (\`plans/<name>.md\`)` ใน `project_summary.md` → เพิ่มใน `INDEX.md`

**Rule 2 — Plan completed:**
ต้องผ่าน **2 เงื่อนไข** ก่อน move — ขาดข้อใดข้อหนึ่ง = ห้าม move:
1. ไม่มี `- [ ]` เหลือในไฟล์ (checkbox ครบ)
2. มี `## ✅ Completion Evidence` section พร้อม **วันที่ + หลักฐาน ≥ 1 ชิ้น** (git commit / test pass / manual verify)

ถ้าครบ → ย้ายไฟล์ → `plans/completed/` → เปลี่ยน `[ ]` เป็น `[x] done YYYY-MM-DD` ใน `project_summary.md` → อัปเดต `INDEX.md`
ถ้าไม่ครบ → เขียน `BLOCKED: missing evidence` แล้วหยุด รอมนุษย์ยืนยัน

**Rule 3 — Bug risk spotted:**
ไม่แก้ถ้าไม่ใช่ scope → สร้าง `memory/reports/<topic>-risk-report.md` พร้อม: ไฟล์, บรรทัด, พฤติกรรม, ความเสี่ยง, วิธี reproduce → เพิ่มใน `gotchas.md` ถ้าเป็น pattern

> รายละเอียด format ทั้งหมด → `memory/AGENTS.md` Section 6b

## Memory files (in this repo)
```
memory/
├── INDEX.md               ← navigation map
├── AGENTS.md              ← format rules (อ่านก่อนเขียนไฟล์ใดๆ ใน memory/)
├── project_summary.md     ← slim core: run, tests, stack, env vars, 74 routers, DB schema, 6 views + ASK, known issues, plans
├── reference/
│   ├── architecture.md         ← data flow, key files, accounting layer, views
│   ├── api-endpoints.md        ← all endpoints + caching strategy + Next.js proxy routes
│   ├── frontend-structure.md   ← full component tree + key exports + keyboard shortcuts
│   ├── data-shapes.md          ← API response shapes (avoid reading router files)
│   ├── data-catalog.md         ← 17 data categories available for analysis
│   ├── data-sources.md         ← where to look for data (read before searching)
│   ├── question-research.md    ← how to answer an open question (signals, answer levels, assumptions)
│   └── thesis-tracking.md      ← tracked numbers: source, forecast vs actual, kill lines
├── plans/                 ← feature plans (active + completed/)
└── sessions/              ← audit trail + reports
```

**Before writing any file in `memory/`: read `memory/AGENTS.md` for format rules.**
