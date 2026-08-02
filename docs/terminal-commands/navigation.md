# Navigation, Settings & Info Commands

---

## Navigation Commands

เปลี่ยน view ทันที — ไม่ต้องกด Enter หลัง Tab complete (กด Enter เพื่อ execute)

| Command | View | Description |
|---------|------|-------------|
| `MKT` | market-view | Watchlist + chart + global indices ticker |
| `NEWS` | news-view | Financial news + social feed + Polymarket |
| `GMOV` | market-movers | Global indices table + heatmap treemap |
| `CLIP` | clippings-view | Obsidian markdown notes + Ollama AI |
| `MACRO` | macro-view | 7 tabs: dashboard, yield, indicators, fed, country, compare, signals |
| `CRDT` | credit-view | 4 tabs: overview, spreads, stress, consumer |
| `PORT` | portfolio-view | 8 tabs: positions, options, trades, analytics, cash, import, theses, risk |

> `CRYP` และ `FX` ถูกลบ 2026-08-01 — FX ย้ายไปอยู่ใน TICK DATA board ของ `MKT`, crypto ใช้ global search (`BTC-USD`) เข้า stock-view แทน

**ตัวอย่าง:**
```
MKT     → ไป market view
PORT    → ไป portfolio view
```

---

## Settings Commands

### ALERT — Ticker Crawl Control

Ticker crawl = แถบราคาเลื่อนด้านล่างทุก view

```
ALERT ON     → เปิด ticker crawl
ALERT OFF    → ซ่อน ticker crawl
ALERT CLEAR  → ล้าง watchlist ออกจาก ticker
```

State เก็บใน Jotai atom `tickerEnabledAtom` — persist ตลอด session

### DARK / LIGHT — Theme

```
DARK    → เปลี่ยนเป็น dark mode
LIGHT   → เปลี่ยนเป็น light mode
```

Toggle ผ่าน `isDarkModeAtom`

### YTD — Year-to-Date Toggle

```
YTD ON     → แสดง YTD column ใน watchlist
YTD OFF    → ซ่อน YTD column
```

---

## Info Commands

### HELP — Command Reference

```
HELP
```

แสดง overlay พร้อมทุก command แบ่งตาม group:
- **ANALYSIS** — ฟังก์ชันวิเคราะห์ทั้ง 10
- **NAV** — navigation commands
- **SETTING** — settings commands
- **INFO** — info commands

ผลลัพธ์: `{kind: "stay"}` — overlay ยังเปิดอยู่ให้อ่าน HELP

### PING — Health Check

```
PING
```

ตรวจสอบ backend alive:
- ดึงข้อมูลจาก `/api/health` (หรือ timestamp)
- แสดง latency ms
- Output: `PONG  42ms`

### REGIME — Market Regime

```
REGIME
```

ดึงข้อมูลจาก `/api/regime/calibrated?period=3m`  
แสดง current market regime: trend strength, vol regime, sector rotation signals

Output format:
```
REGIME  [3m]
TREND   Bullish Momentum  0.72
VOL     Low               VIX=14.2
SECTOR  Tech/Growth leading
```

---

## Symbol Lookup (Not a Command)

พิมพ์ ticker symbol ที่ไม่ match command ใด → เข้า stock analysis view

```
AAPL       → เปิด Apple stock analysis (9 tabs)
^SET.BK    → SET Index
BTC-USD    → Bitcoin (ใน crypto context)
```

Handler: `ctx.setStockSymbol(symbol); ctx.setView("stock")`

---

## คำสั่ง Multi-word

Command ที่มีมากกว่า 1 word — ต้องพิมพ์ทั้งหมด:

```
ALERT ON     ✓
ALERT OFF    ✓
ALERT CLEAR  ✓
YTD ON       ✓
YTD OFF      ✓
```

Tab completion ช่วยได้:
```
ALERT → Tab → ALERT CLEAR (first match)
กด Tab อีก → ALERT OFF → ALERT ON
```
