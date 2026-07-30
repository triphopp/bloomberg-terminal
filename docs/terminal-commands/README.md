# Terminal Command System — Overview

Bloomberg-style command language สำหรับ Bloomberg Terminal  
เปิดด้วย `/` หรือ `Ctrl+K` จากทุก view

---

## ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | เนื้อหา |
|------|---------|
| `README.md` | Overview + วิธีใช้พื้นฐาน (ไฟล์นี้) |
| `functions.md` | Analysis functions ทุกตัว — math + parameters + ตัวอย่าง |
| `navigation.md` | Nav commands + Setting commands + Info commands |
| `architecture.md` | โครงสร้างระบบ — Lexer → Parser → Registry → Executor |
| `examples.md` | Use cases จริง, recipes, workflow |

---

## วิธีเปิด

```
/          กด slash ใน view ใดก็ได้ (ไม่ต้องอยู่ใน input)
Ctrl+K     ทางเลือก
```

Overlay จะเปิดขึ้น — มี 2 โหมด:

---

## 2 โหมดหลัก

### 1. Command Mode (คำสั่ง / ฟังก์ชัน)

เริ่มต้นเมื่อ:
- First word ตรง **exact** กับชื่อ command ที่ register ไว้
- มีวงเล็บเปิด `(` → function call

```
corr(AAPL, MSFT, 3m)    → คำนวณ correlation แสดงผลใน overlay
MKT                      → navigate ไป Market view
ALERT OFF                → ซ่อน ticker crawl
HELP                     → แสดง command ทั้งหมด
```

### 2. Stock Search Mode (default)

เมื่อ input ไม่ตรง command ใด → search หุ้นจาก yfinance

```
AAPL                     → แสดง Apple + company name + exchange
^SET.BK                  → SET Index
tesla                    → company name search
```

---

## Tab Completion

กด `Tab` เพื่อ autocomplete:
```
cor → Tab → corr(
corr( → Tab → hint: <A>  (required symbol)
ALERT → Tab → ALERT CLEAR (first match)
```

---

## Quick Reference

### Analysis Functions

| Syntax | Output |
|--------|--------|
| `corr(A, B, period?)` | Pearson correlation |
| `beta(A, B?, period?)` | Beta vs benchmark |
| `vol(A, period?)` | Annualised volatility |
| `return(A, period?)` | Total return |
| `drawdown(A, period?)` | Max drawdown |
| `sharpe(A, period?)` | Sharpe ratio |
| `zscore(A, period?)` | Z-score vs rolling mean |
| `rsi(A, window?)` | RSI (Wilder) |
| `stat(A, period?)` | Full stats: descriptive + risk + diagnostic tests |
| `compare(A,B,C, period?)` | Side-by-side table |
| `rank(A,B,C, METRIC, period?)` | Sorted ranking |

### Period values

```
5d  1m  3m  6m  1y  2y  5y
```

### Navigation

```
MKT   NEWS   GMOV   CLIP   MACRO   CRDT   PORT   CRYP   FX
```

### Settings

```
ALERT ON / OFF / CLEAR
DARK / LIGHT
YTD ON / YTD OFF
```

### Info

```
REGIME    HELP    PING
```

---

## ตัวอย่างเร็ว

```
corr(AAPL, ^SET.BK, 1y)
compare(AAPL, MSFT, NVDA, TSLA, 6m)
rank(AAPL, MSFT, NVDA, SHARPE, 1y)
beta(SCB.BK, ^SET.BK, 3m)
zscore(GLD, 2y)
```

---

## ไฟล์ Implementation

```
components/bloomberg/terminal/
├── types.ts        — Token, AstNode, CommandResult, TerminalCtx
├── lexer.ts        — tokenizer
├── parser.ts       — tokens → AST
├── validator.ts    — type-check args ก่อน execute
├── registry.ts     — ทุก command + handler function
├── executor.ts     — execute AST (abort-safe)
├── autocomplete.ts — context-aware suggestions
└── index.ts        — re-exports

backend/routers/analytics.py   — Python endpoints สำหรับ analysis functions
app/api/analytics/route.ts     — Next.js proxy
```
