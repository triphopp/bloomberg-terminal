# Terminal Command Reference

> Access via global search: press `/` or `Ctrl+K` anywhere in the terminal.
> Type a command keyword → command mode activates (no stock search). `Enter` or click to execute.

---

## Alert Commands

| Command | Action |
|---------|--------|
| `ALERT ON` | Show Bloomberg ticker crawl (bottom strip) |
| `ALERT OFF` | Hide Bloomberg ticker crawl |
| `ALERT CLEAR` | Clear all regime change alert events (stop loss alerts persist until price recovers) |

---

## View Navigation

| Command | View |
|---------|------|
| `MKT` | Market view — watchlist, chart, regime panel |
| `NEWS` | News — financial feed + Polymarket column |
| `GMOV` | Market Movers — indices table + heatmap |
| `CLIP` | Clippings — Obsidian notes + Ollama AI |
| `MACRO` | Macro Economics — 7 tabs |
| `CRDT` | Credit / Stress — 4 tabs |
| `PORT` | Portfolio — 8 tabs |
| `CRYP` | Crypto — 20 coins + chart |
| `FX` | FX / Forex — 20 pairs + chart |

Keyboard equivalents: `1`–`6`, `P`, `C`, `E` (same views, no overlay needed).

---

## Display Commands

| Command | Action |
|---------|--------|
| `DARK` | Switch to dark mode |
| `LIGHT` | Switch to light mode |
| `YTD ON` | Show YTD % column in market table |
| `YTD OFF` | Show Daily % column in market table |

---

## Info Commands

| Command | Action |
|---------|--------|
| `REGIME` | Show current CORR regime label (stays open) |
| `HELP` | List all commands |

---

## Ticker Crawl (Bottom Strip)

Always-on scrolling bar at bottom of terminal. Content order:

```
[LIVE/ALERT]  SPX ▲  NDX ▼  INDU  VIX  XAU  WTI  EUR/USD  USD/JPY  USD/THB  |  REGIME TRENDING
```

Alert items prepended when active:

```
⚑ STOP BREACH  AAPL  CUR 181.20  SL 185.40  −2.26%
[REGIME CHG  TRENDING / RISK-OFF]
```

**Alert types:**

| Type | Trigger | Duration | Badge color |
|------|---------|----------|-------------|
| Stop Loss | `current_price < stop_dynamic` | Persistent (until price recovers) | 🔴 `#CC0000` |
| Regime Change | CORR label transitions | 15 minutes, then auto-expire | 🟠 `#CC6600` |

**Regime pill colors:**

| Label | Background | Text |
|-------|-----------|------|
| CRISIS | `#DD0000` red | white |
| RISK-OFF | `#CC6600` orange | black |
| TRENDING | `#CCAA00` gold | black |
| DIVERGENT | `#00AA66` green | black |

Ticker polls `/api/ticker` every 60s. Disable via `ALERT OFF` command or persist with `ALERT ON`.

---

## Implementation Files

| File | Role |
|------|------|
| `components/bloomberg/core/global-search.tsx` | Command detection + execution |
| `components/bloomberg/layout/alert-ticker.tsx` | Ticker crawl rendering |
| `components/bloomberg/atoms/index.ts` | `tickerEnabledAtom` |
| `backend/routers/ticker.py` | `GET /api/ticker` — indices + FX + commodities + alerts |
| `backend/routers/alerts.py` | `GET /api/alerts`, `DELETE /api/alerts/regime/clear` |
| `backend/db.py` | `regime_alerts` table (from_label, to_label, expires_at) |

**Command mode detection:** first word of query (uppercased) must be in `CMD_FIRST_WORDS` set. Falls through to stock search otherwise — zero conflict.
