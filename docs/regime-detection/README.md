# Regime Detection — Overview

US Sector Correlation & Geometric Regime Detection module ใน Bloomberg Terminal

---

## ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | เนื้อหา |
|------|---------|
| [README.md](README.md) | ภาพรวม, architecture, quick reference |
| [calculation.md](calculation.md) | วิธีคำนวณ CORR และ GEOM อย่างละเอียด |
| [interpretation.md](interpretation.md) | วิธีอ่านค่า, ตีความ regime, ตัวอย่างสถานการณ์จริง |

---

## ภาพรวม

ระบบวัด **regime ของตลาด** จาก correlation ของ sector ETF ทั้ง 11 ตัวใน S&P 500 โดยมี 2 โหมดการวิเคราะห์:

- **CORR** — Pearson Correlation Matrix + avg |ρ| regime score
- **GEOM** — Geometric analysis ด้วย Wedge Product และ Gram Determinant

---

## Universe: US Sector ETFs (GICS)

| Symbol | Sector | Abbr |
|--------|--------|------|
| XLK | Technology | TECH |
| XLF | Financials | FIN |
| XLV | Health Care | HLTH |
| XLE | Energy | ENRG |
| XLI | Industrials | INDU |
| XLY | Consumer Discretionary | COND |
| XLP | Consumer Staples | CONS |
| XLRE | Real Estate | REIT |
| XLU | Utilities | UTIL |
| XLB | Materials | MATR |
| XLC | Communication Services | COMM |

---

## Regime Labels

### CORR Mode (score = avg |ρ|)

| Label | Score Range | ความหมาย |
|-------|-------------|----------|
| DIVERGENT | < 0.40 | sectors เคลื่อนอิสระ — stock picker's market |
| TRENDING | 0.40–0.55 | มี market trend ชัด แต่ sector divergence ยังมีอยู่ |
| RISK-OFF | 0.55–0.70 | correlation สูง — นักลงทุนขายทุกอย่างพร้อมกัน |
| CRISIS | > 0.70 | correlation สูงมาก — panic selling / systemic risk |

### GEOM Mode (score = det(C)^(1/N))

| Label | Score Range | ความหมาย |
|-------|-------------|----------|
| CORRELATED | < 0.25 | vectors เกือบ parallel — sectors ไม่แยกกัน |
| TRENDING | 0.25–0.45 | market beta dominant, sector rotation น้อย |
| MIXED | 0.45–0.65 | ผสม beta + sector alpha — transitional regime |
| DIVERGENT | > 0.65 | sectors เคลื่อนอิสระ — high alpha opportunity |

---

## Architecture

```
backend/routers/regime.py          ← FastAPI endpoint
app/api/regime/correlation/route.ts ← Next.js proxy
components/bloomberg/views/
  sector-regime-heatmap.tsx         ← React component
```

**Endpoint:** `GET /api/regime/correlation?mode=corr|geom&period=1m|3m|6m|1y`

**Cache:** 5 นาที (server-side)

**Data source:** yfinance daily/weekly closes → pct_change() → correlation

---

## UI Controls

```
REGIME  [CORR|GEOM]  [MTX|SPC*]  [1m|3m|6m|1y]  [⤢]
         ↑              ↑            ↑               ↑
      mode toggle    sub-view    lookback       expand modal
                   (GEOM only)

* MTX = Matrix view  |  SPC = Wedge Space PCA view
```

Default ทุก setting **auto-save** ลง localStorage — ไม่ต้องตั้งใหม่ทุกครั้ง
