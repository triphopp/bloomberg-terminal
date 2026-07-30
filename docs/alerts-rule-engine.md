# Alert Rule Engine — ออกแบบระบบแจ้งเตือนแบบ Boolean Algebra

**สถานะ:** design draft (ยังไม่ implement)
**ขอบเขต:** ระบบ alert สำหรับ WATCHLIST ที่ผสมเงื่อนไขจากหลาย indicator ได้ด้วย AND/OR/NOT
พร้อม modal สำหรับสร้าง/แก้ rule

---

## 0. ไอเดียหลัก

ทั้งระบบมีของอยู่ **ชิ้นเดียว** คือ AST ของ boolean expression ทุกอย่างที่เหลือคือทางเข้า-ทางออกของมัน:

```
Label preset ──┐
Custom compare ─┼──► RuleNode (AST) ──► NNF normalize ──► evaluate(bars) ──► boolean series ──► trigger
Text expression ┘                                                                 │
                                                                                  ├─► preview (dry-run)
                                                                                  └─► fire event ──► alert-ticker
```

**label ไม่ใช่ระบบแยก** — label คือ "predicate template ที่ตั้งชื่อไว้" ที่ expand เป็น AST subtree
ก่อนถึง evaluator ดังนั้นมี evaluator เดียว, มี storage format เดียว, ทดสอบที่เดียว
และ label กับ custom ผสมกันใน rule เดียวได้โดยไม่ต้องมีโค้ดพิเศษ

---

## 1. AST

```ts
// lib/alerts/ast.ts

export type RuleNode =
  | { op: "and";  children: RuleNode[] }
  | { op: "or";   children: RuleNode[] }
  | { op: "not";  child: RuleNode }
  // temporal quantifier — ทำงานบน boolean series ที่ได้จาก child
  | { op: "within";    bars: number; child: RuleNode }   // เป็นจริง "ภายใน n แท่งที่ผ่านมา"
  | { op: "sustained"; bars: number; child: RuleNode }   // เป็นจริงติดกัน n แท่ง
  | Predicate;

export interface Predicate {
  op: "cmp";
  left: Operand;
  cmp: Comparator;
  right: Operand;
  /** ตัวที่สองสำหรับ between / outside เท่านั้น */
  right2?: Operand;
  /** ที่มา — ไว้ให้ UI แสดงกลับเป็น label chip แทน raw compare */
  origin?: { kind: "label"; indicator: string; label: string };
}

export type Comparator =
  | "lt" | "lte" | "gt" | "gte" | "eq" | "neq"
  | "crossesAbove" | "crossesBelow"      // X[t] cmp Y[t] && !(X[t-1] cmp Y[t-1])
  | "between" | "outside";

export type Operand =
  | { src: "indicator"; id: string; params: Record<string, number | string | boolean>;
      output: string; offset?: number }   // offset = ย้อนหลังกี่แท่ง (default 0)
  | { src: "price"; field: "open" | "high" | "low" | "close" | "volume"; offset?: number }
  | { src: "const"; value: number }
  | { src: "pctRank"; of: Operand; window: number };   // percentile ใน n แท่ง → 0..1
```

หมายเหตุการออกแบบ:

- **`crossesAbove` ไม่ใช่ operator ใหม่จริง ๆ** — มันคือ `X > Y AND NOT (X[-1] > Y[-1])` แต่เก็บเป็น
  comparator เพื่อให้ UI แสดงเป็นคำเดียวและ normalize ได้สะอาด
- **`pctRank`** สำคัญกว่าที่คิด: indicator อย่าง BB Width / ATR% ไม่มี absolute threshold ที่ใช้ได้ข้ามหุ้น
  "squeeze" ที่ถูกต้องคือ `pctRank(bb_width, 120) < 0.1` ไม่ใช่ `bb_width < 0.05`
- **`offset`** ทำให้เขียน "RSI วันนี้ > RSI เมื่อวาน" ได้โดยไม่ต้องมี node ชนิดใหม่
- `within` / `sustained` เป็น monotone operator บน boolean series — De Morgan ยังใช้ได้ปกติ
  (`NOT within(n, X)` = "ไม่เกิดเลยใน n แท่ง" ซึ่งถูกต้องตามความหมายที่ต้องการ)

### ทำไมต้องมี temporal operator

boolean algebra ล้วน ๆ ตอบไม่ได้กับเคสที่ใช้จริงบ่อยที่สุด:

> "MACD ตัดขึ้น **ภายใน 3 วันที่ผ่านมา** AND RSI ยังต่ำกว่า 45"

ถ้าไม่มี `within` ผู้ใช้ต้องเขียน `cross[0] OR cross[-1] OR cross[-2]` เอง ซึ่งพังทันทีที่เปลี่ยนเลข
สองตัวนี้ครอบคลุมเกือบทุกเคสจริง และไม่ทำให้ algebra เสีย

---

## 2. Semantic Label Registry

ขยาย `IndicatorRegistryEntry` ใน `components/bloomberg/chart/types.ts` เพิ่ม 2 field:

```ts
export interface IndicatorRegistryEntry {
  // ...ของเดิม: id, name, category, type, defaultParams, timeScalableParams

  /** เส้น/ค่าที่ indicator นี้พ่นออกมา — ใช้เป็น Operand ได้ */
  outputs?: IndicatorOutput[];
  /** preset ความหมายพร้อมใช้ */
  alertLabels?: AlertLabel[];
}

export interface IndicatorOutput {
  key: string;                 // "rsi" | "macd" | "signal" | "hist" | "upper" ...
  label: string;               // "RSI" | "MACD Line" | "Histogram"
  /** ช่วงค่าตามธรรมชาติ — modal ใช้ตั้ง min/max ของ slider */
  range?: [number, number];
  /** true = ค่าเทียบข้ามหุ้นไม่ได้ (ราคา, volume) → modal เชียร์ให้ใช้ pctRank */
  unbounded?: boolean;
}

export interface AlertLabel {
  /** ความหมายกลาง ไม่ผูกกับ indicator — ดู §8.5.1 */
  concept: LabelConcept | `x:${string}`;
  /** โหมดการตีความที่รองรับ ตัวแรกเป็น default — ดู §8.5.2 */
  calibrations: Calibration["mode"][];
  /** พารามิเตอร์ที่ปรับได้เฉพาะ label นี้ (เช่น threshold) */
  params?: IndicatorParam[];
  /** expand เป็น AST */
  build: (ctx: LabelBuildCtx) => RuleNode;
}
```

> `name` / `desc` / `polarity` **ไม่อยู่ตรงนี้** — มาจาก `CONCEPT_META` เพื่อให้ทุก indicator
> ที่ implement concept เดียวกันใช้ศัพท์ตรงกัน ส่วน `desc` generate จาก AST ที่ compile ได้จริง
> ไม่ใช่เขียนมือ (§8.5.5)

ตัวอย่างใน `indicators/rsi.ts`:

```ts
outputs: [{ key: "rsi", label: "RSI", range: [0, 100] }],
alertLabels: [
  {
    concept: "oversold",
    calibrations: ["static", "adaptive", "regime"],
    params: [{ key: "th", label: "Threshold", type: "number", default: 30, min: 1, max: 50 }],
    build: ({ indParams, labelParams, calibration }) => {
      const rsi = { src: "indicator", id: "rsi",
                    params: { period: indParams.period }, output: "rsi" } as const;
      if (calibration.mode === "adaptive")
        return { op: "cmp", left: { src: "pctRank", of: rsi, window: calibration.window },
                 cmp: "lte", right: { src: "const", value: 0.1 } };
      // static — regime mode ดู §8.5.2 (compile เป็น disjunction ของสองสาขา)
      return { op: "cmp", left: rsi, cmp: "lte",
               right: { src: "const", value: labelParams.th } };
    },
  },
  {
    concept: "exitingOversold",
    calibrations: ["static"],
    params: [{ key: "th", label: "Threshold", type: "number", default: 30, min: 1, max: 50 }],
    build: ({ indParams, labelParams }) => ({
      op: "cmp",
      left:  { src: "indicator", id: "rsi", params: { period: indParams.period }, output: "rsi" },
      cmp:   "crossesAbove",
      right: { src: "const", value: labelParams.th },
    }),
  },
  { concept: "overbought", /* gte th=70 */ },
  { concept: "aboveMid",   /* gt 50 */ },
]
```

### ชุด label เริ่มต้นต่อ indicator

| Indicator | Labels |
|---|---|
| RSI | oversold, overbought, exitingOversold, exitingOverbought, aboveMid |
| Stochastic | oversold, overbought, kCrossD (bull/bear) |
| MACD | bullCross, bearCross, aboveZero, histExpanding |
| EMA / SMA | priceAbove, priceBelow, crossUp(fast/slow), slopeUp |
| Bollinger | squeeze (`pctRank(width,120) < 0.1`), pierceUpper, pierceLower, midReclaim |
| Bollinger %B | above1, below0 |
| BB Width | squeeze, expansion |
| RVOL / Volume | spike (≥2), dryUp (≤0.5) |
| VWAP | above, below, reclaim |
| Regression Channel | atUpperBand, atLowerBand |
| Flow Toxicity / Absorption / Footprint | ตามความหมายเฉพาะของแต่ละตัว |
| Volume Profile | aboveVAH, belowVAL, atPOC |

**กติกา fallback ที่ทำให้ "ใช้ได้กับทุก indicator" เป็นจริง:**
indicator ที่ยังไม่ประกาศ `alertLabels` จะยังใช้ได้เต็มที่ใน **custom compare mode** ผ่าน `outputs`
(ถ้าไม่ประกาศ `outputs` เลย ให้ derive จากชื่อ series ที่ compute function คืนมา)
→ indicator ใหม่ที่ใครเพิ่มเข้ามาในอนาคตได้ alert ฟรีทันที ส่วน label เป็น opt-in ที่ค่อยเติมทีหลัง

---

## 3. Rule

```ts
export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  scope: { type: "watchlist" } | { type: "symbols"; symbols: string[] };
  timeframe: BarInterval;              // v1 รองรับ "1d" (ดู §7 ข้อจำกัด)
  expr: RuleNode;

  trigger: "edge" | "level";           // default "edge"
  cooldownBars: number;                // default 1
  maxFiresPerDay?: number;
  expiresAt?: string;

  notify: ("ticker" | "toast" | "sound" | "webhook")[];
  webhookUrl?: string;

  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
}
```

### Trigger semantics — จุดที่พังบ่อยที่สุดถ้าไม่ออกแบบ

rule ที่เป็นจริง 20 แท่งติดกันต้องไม่ยิง 20 ครั้ง:

- **`edge`** (default) — ยิงตอน false→true เท่านั้น เก็บ `lastState` ต่อ (rule, symbol)
- **`level`** — ยิงทุกครั้งที่ scan แล้วเป็นจริง (ใช้กับ rule ที่เป็นจริงสั้น ๆ เช่น cross)
- **`cooldownBars`** — ยิงแล้วเงียบ n แท่ง กันการกระพริบรอบ threshold
- **bar-time dedup** — key การยิงด้วย `(ruleId, symbol, barTime)` กัน scan ซ้ำใน 15 นาทีเดียวกันยิงซ้ำ

state ต่อ (rule, symbol) จำเป็น ไม่ใช่ optional — เก็บใน `alert_rule_state`

---

## 4. Normalization + Validation (คุณค่าจริงของ boolean algebra)

ก่อน eval/save ให้ผ่าน pipeline:

1. **NNF** — ดัน `not` ลงไปที่ leaf ด้วย De Morgan
   (`not(cmp lt)` → `cmp gte`; `not(and)` → `or(not…)`)
2. **Flatten** — รวม `and` ซ้อน `and` เป็นชั้นเดียว
3. **Dedup** — predicate ที่ hash เท่ากันในกลุ่มเดียวกัน ตัดทิ้ง
4. **Interval analysis** ต่อ operand เดียวกัน → ตรวจได้ว่า:
   - **ขัดแย้ง** `RSI<30 AND RSI>70` → ไม่มีวันเกิด → modal ขึ้นเตือนสีแดง ห้าม save
   - **ซ้ำซ้อน** `RSI<30 AND RSI<50` → เตือนว่าตัวหลังไม่มีผล
   - **tautology** `RSI>0` → เตือนว่ายิงทุกแท่ง

ข้อ 4 คือเหตุผลที่ควรทำเป็น AST ตั้งแต่แรกแทนที่จะเก็บเป็น string — ระบบ "รู้" ว่า rule ที่ผู้ใช้เขียนพัง
ก่อนที่เขาจะรอมันยิงอยู่สองสัปดาห์แล้วมาบ่นว่าไม่ทำงาน

canonical form ยังทำให้เทียบ rule ว่าซ้ำกันได้ และใช้เป็น cache key ของ preview ได้ด้วย

---

## 5. Storage (SQLite — ต่อจาก `backend/portfolio.db`)

```sql
CREATE TABLE alert_rules (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  scope_json    TEXT NOT NULL,
  timeframe     TEXT NOT NULL DEFAULT '1d',
  expr_json     TEXT NOT NULL,          -- AST
  trigger       TEXT NOT NULL DEFAULT 'edge',
  cooldown_bars INTEGER NOT NULL DEFAULT 1,
  notify_json   TEXT NOT NULL DEFAULT '["ticker"]',
  webhook_url   TEXT,
  expires_at    TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE alert_rule_state (
  rule_id       TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  last_state    INTEGER NOT NULL DEFAULT 0,
  last_bar      TEXT,
  last_fired_at TEXT,
  fires_today   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, symbol),
  FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
);

CREATE TABLE alert_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id       TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  fired_at      TEXT NOT NULL,
  bar_time      TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,   -- ค่า operand ทุกตัวตอนยิง → ไว้ debug ย้อนหลังได้
  acked         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (rule_id, symbol, bar_time)   -- dedup ระดับ DB
);
CREATE INDEX idx_alert_events_fired ON alert_events(fired_at DESC);
```

`schema_version` ไว้ migrate AST เมื่อเพิ่ม node ชนิดใหม่ — เก็บ AST เป็น JSON ดิบ
แล้วมี migration function ต่อเวอร์ชัน ไม่ใช่แก้ในที่

`snapshot_json` คุ้มมาก: เวลา alert ยิงแล้วสงสัยว่าทำไม ดูค่าที่ทำให้มันยิงได้ทันทีโดยไม่ต้อง reproduce

---

## 6. Backend

โมดูลใหม่ `backend/alerts/`:

```
backend/alerts/
├── ast.py        # dataclass + validate + normalize(NNF) + contradiction check
├── operands.py   # OperandResolver — compute indicator series, memoized ต่อ scan
├── eval.py       # evaluate(node, ctx) -> np.ndarray[bool]
├── engine.py     # scan(rules, symbols) -> events + state transition
└── migrations.py # schema_version upgrades
```

router ใหม่ `backend/routers/alert_rules.py`:

| Method | Path | ทำอะไร |
|---|---|---|
| GET | `/api/alerts/rules` | list |
| POST | `/api/alerts/rules` | create (validate + normalize ก่อนเก็บ) |
| PATCH | `/api/alerts/rules/{id}` | update |
| DELETE | `/api/alerts/rules/{id}` | delete (cascade state) |
| POST | `/api/alerts/rules/preview` | **dry-run** — ไม่บันทึก ดู §8 |
| POST | `/api/alerts/scan` | รัน scan (เรียกจาก scheduler หรือ manual) |
| GET | `/api/alerts/events` | feed สำหรับ `alert-ticker.tsx` |
| POST | `/api/alerts/events/ack` | mark อ่านแล้ว |

### หัวใจด้าน performance: operand-level memoization

N rules × M symbols ไม่ควรกลายเป็น N×M การคำนวณ indicator เพราะ rule ส่วนใหญ่ใช้ indicator ซ้ำกัน

```python
def scan(rules, symbols):
    frames = download_batch(symbols)          # ใช้ pattern เดิมจาก watchlist_signals.py
                                              # (yf.download ครั้งเดียว + TTLCache 15 นาที)
    # เก็บ operand ที่ไม่ซ้ำจากทุก rule ก่อน
    needed = {op_key(o) for r in rules for o in walk_operands(r.expr)}

    events = []
    for sym, df in frames.items():
        cache = {k: compute(k, df) for k in needed}     # คำนวณครั้งเดียวต่อ symbol
        for rule in rules_for(sym, rules):
            series = evaluate(rule.expr, cache, df)     # np.ndarray[bool] ยาวเท่าจำนวนแท่ง
            ev = apply_trigger(rule, sym, series, df)   # edge/level + cooldown + state
            if ev: events.append(ev)
    return events
```

ทำให้ต้นทุนเป็น `O(distinct operands × symbols)` ไม่ใช่ `O(rules × symbols)`
เพิ่ม rule ที่ 50 ที่ใช้ RSI(14) เหมือนใครแล้วแทบไม่มีต้นทุนเพิ่ม

**การคืนค่าเป็น series ทั้งเส้น ไม่ใช่ scalar ของแท่งสุดท้าย** เป็นการตัดสินใจที่สำคัญ —
`crossesAbove`, `within`, `sustained`, และ preview backtest ล้วนต้องการประวัติ
ต้นทุนแทบเป็นศูนย์เพราะ numpy คำนวณทั้งเส้นอยู่แล้ว

### Scheduler

รอบเดียวกับ scanner เดิมคือ 15 นาที — ผูกเข้ากับ `_cache` TTL ของ `watchlist_signals.py`
จะได้ไม่ยิง yfinance ซ้ำซ้อน โหมด `1d` ยิงจริงแค่วันละไม่กี่ครั้งที่มีความหมาย

---

## 7. ข้อจำกัดที่ต้องรู้ก่อนเริ่ม

1. **`watchlist_signals.py` ปัจจุบันเป็น daily-only** (`interval="1d"`, lookback 2y)
   v1 ควรล็อก timeframe ที่ `1d` ให้ตรงกับความจริง ถ้าเปิดให้เลือก intraday ใน modal
   ต้องเพิ่ม fetch path ใหม่ + cache policy ใหม่ (intraday TTL ต้องสั้นกว่ามาก)
2. **แท่งสุดท้ายยังไม่ปิดระหว่างตลาดเปิด** — RVOL/Volume จะดูต่ำผิดปกติ
   `_scan` มี comment เตือนเรื่องนี้อยู่แล้ว engine ต้องมี option `evaluateOnClosedBarsOnly`
   (default true) ไม่งั้น rule volume จะยิงมั่วทุกเช้า
3. **MTF (predicate อ้าง timeframe อื่น)** — ไม่เอาใน v1 ออกแบบ `Operand` เผื่อ field `tf?`
   ไว้แล้วเพื่อเติมทีหลังโดยไม่ต้อง migrate

---

## 8. Preview / Dry-run — ฟีเจอร์ที่ทำให้ระบบใช้ได้จริง

`POST /api/alerts/rules/preview { expr, scope, timeframe, trigger, cooldownBars }` คืน:

```json
{
  "matchingNow": ["NVDA", "AMD"],
  "perSymbol": {
    "NVDA": { "firesLast250Bars": 7, "lastFiredBar": "2026-07-14", "currentlyTrue": true }
  },
  "totalFires": 41,
  "warnings": ["ยิงเฉลี่ย 8.2 ครั้ง/หุ้น/ปี — เงื่อนไขอาจหลวมเกินไป"],
  "diagnostics": { "contradiction": false, "tautology": false, "redundant": [] }
}
```

ต้นทุนแทบเป็นศูนย์เพราะ bars 2 ปีถูก cache ไว้อยู่แล้วและ evaluator คืน series ทั้งเส้นอยู่แล้ว
แต่ผลลัพธ์คือผู้ใช้ปรับ threshold แล้วเห็นทันทีว่า "ต่ำกว่า 30" กับ "ต่ำกว่า 25" ต่างกันแค่ไหน
และจับ rule ที่ยิงทุกแท่งได้ก่อน save

---

## 8.5 การตีความของ Label — ใครเป็นคนตัดสินว่า "oversold" แปลว่าอะไร

ปัญหาหลักคือ label ไม่ใช่ข้อเท็จจริง มันคือ **ความเห็น** ที่ถูก encode ไว้
`RSI ≤ 30 = oversold` เป็นแค่ธรรมเนียมของ Wilder ปี 1978 ไม่มีอะไรรับรองว่าใช้ได้กับ NVDA ปี 2026
หรือกับหุ้นไทยที่ volatility คนละสเกล ระบบต้องยอมรับตรงนี้ตั้งแต่ออกแบบ ไม่ใช่ hardcode แล้วหวังว่าจะรอด

แยกเป็น 5 เรื่องที่ต้องตัดสินใจแยกกัน

### 8.5.1 แยก "ความหมาย" ออกจาก "วิธีวัด"

label ต้องมีสองชั้น: **concept** (คำศัพท์กลางที่ใช้ร่วมกันทั้งระบบ) กับ **implementation**
(indicator แต่ละตัวตีความ concept นั้นด้วยสูตรของตัวเอง)

```ts
// lib/alerts/concepts.ts — คำศัพท์กลาง ไม่ผูกกับ indicator ใด
export type LabelConcept =
  | "oversold" | "overbought"
  | "exitingOversold" | "exitingOverbought"
  | "bullCross" | "bearCross"
  | "aboveMid" | "belowMid"
  | "compression" | "expansion"
  | "spike" | "dryUp"
  | "priceAbove" | "priceBelow"
  | "risingSlope" | "fallingSlope"
  | "extremeHigh" | "extremeLow";

export const CONCEPT_META: Record<LabelConcept, {
  name: string;
  nameTh: string;
  family: "reversion" | "momentum" | "breakout" | "participation" | "regime";
  /** hint เท่านั้น — ดู §8.5.4 */
  defaultPolarity: "bullish" | "bearish" | "neutral";
  doc: string;
}> = {
  oversold: {
    name: "Oversold", nameTh: "ขายมากเกินไป", family: "reversion",
    defaultPolarity: "bullish",
    doc: "ตัวชี้วัดอยู่ปลายล่างของช่วงค่าปกติ — บอกว่าราคาลงเร็วเทียบกับตัวเอง ไม่ได้บอกว่าจะกลับตัว",
  },
  // ...
};
```

แล้วแต่ละ indicator ประกาศว่า **มัน implement concept ไหนได้บ้าง**:

```ts
// indicators/rsi.ts
alertLabels: [
  { concept: "oversold",   build: /* RSI <= th */ },
  { concept: "exitingOversold", build: /* RSI crossesAbove th */ },
]
// indicators/stochastic.ts
alertLabels: [
  { concept: "oversold",   build: /* %K <= 20 */ },   // เลขคนละตัว แต่ concept เดียวกัน
]
// indicators/bollinger-b.ts
alertLabels: [
  { concept: "oversold",   build: /* %B <= 0 */ },
]
```

ได้อะไร:

- **ศัพท์ตรงกันทั้งระบบ** ผู้ใช้เรียนรู้คำว่า "oversold" ครั้งเดียว ใช้ได้กับทุก indicator
- **ค้นข้ามตัวได้** — modal มีโหมด "เลือกจากความหมาย": พิมพ์ `oversold` แล้วเห็นว่ามี RSI, Stochastic,
  %B, Williams %R ที่ทำได้ พร้อมสูตรของแต่ละตัว ให้เลือกว่าจะใช้ตัวไหน (หรือ OR รวมกันเลย)
- **เตือนความซ้ำซ้อนเชิงความหมาย** — RSI oversold AND Stochastic oversold AND %B oversold
  ไม่ใช่ 3 เงื่อนไข มันคือเงื่อนไขเดียววัด 3 วิธีที่ correlate กันสูงมาก
  modal เตือนว่า "3 เงื่อนไขนี้เป็น family `reversion` ทั้งหมด — แทบไม่เพิ่มความเข้มงวด"
- **เตือนความขัดแย้งเชิงความหมาย** ที่ interval analysis (§4) จับไม่ได้ เพราะมันคนละ operand:
  `RSI overbought AND MACD bullCross` ไม่ผิด logic แต่เป็นการผสม `reversion` กับ `momentum`
  ที่ตีกันเอง → เตือนแบบ info ไม่บล็อก

indicator ที่มีความหมายเฉพาะตัวจริง ๆ (Volume Profile `atPOC`, Footprint `absorption`)
ใช้ `concept: "x:atPOC"` — prefix `x:` แปลว่า local ไม่เข้าคำศัพท์กลาง ไม่ต้องยัดทุกอย่างเข้า enum

### 8.5.2 Calibration mode — ตีความเลขเดียวกันได้ 3 แบบ

นี่คือคำตอบหลักของคำถาม "แล้วตีความยังไง" — **ไม่ตอบแทนผู้ใช้ แต่ให้เลือกวิธีตีความ**

```ts
export type Calibration =
  | { mode: "static" }                                  // ธรรมเนียม: RSI ≤ 30
  | { mode: "adaptive"; window: number }                // สถิติของหุ้นตัวเอง
  | { mode: "regime"; by: "trend" };                    // ขึ้นกับบริบท

export interface AlertLabel {
  concept: LabelConcept | `x:${string}`;
  /** โหมดที่ label นี้รองรับ — โหมดแรกคือ default */
  calibrations: Calibration["mode"][];
  params?: IndicatorParam[];
  build: (ctx: {
    indParams: Record<string, number>;
    labelParams: Record<string, number>;
    calibration: Calibration;
  }) => RuleNode;
}
```

**`static`** — `RSI(14) <= 30`
ธรรมเนียม อ่านง่าย เทียบกับคนอื่นได้ แต่ไม่ยุติธรรมข้ามหุ้น: หุ้น vol ต่ำอาจไม่เคยแตะ 30 เลยทั้งปี

**`adaptive`** — `pctRank(RSI(14), 252) <= 0.10`
"oversold = RSI อยู่ใน 10% ล่างสุดของตัวมันเองในรอบปี" ทุกหุ้นมีโอกาสยิงเท่ากันโดยนิยาม
เหมาะกับ watchlist ที่ปนหุ้นไทย/US/คริปโตซึ่ง distribution ต่างกันมาก
ข้อเสีย: หุ้นที่ลงตลอดทั้งปีก็ยัง "oversold" อยู่ดีเพราะเทียบกับตัวเอง

**`regime`** — threshold ขยับตามบริบท
```
(trend = UP   AND RSI <= 40)      ← ย่อในขาขึ้น 40 ก็ลึกพอแล้ว
OR
(trend ≠ UP   AND RSI <= 20)      ← ขาลง 30 คือปกติ ไม่ใช่สัญญาณ
```
จุดสำคัญ: **โหมดนี้ไม่ต้องเพิ่มอะไรใน evaluator เลย** มันคือ disjunction ธรรมดา
compile ลง AST เดิมได้ 100% — boolean algebra ที่เลือกไว้ครอบคลุมการตีความเชิงบริบทอยู่แล้ว

ทั้งสามโหมดออกมาเป็น `RuleNode` เหมือนกันหมด evaluator ไม่รู้ด้วยซ้ำว่ามี concept ของ calibration อยู่

### 8.5.3 ลำดับชั้นการ override

```
1. system default   ค่าในโค้ด — ธรรมเนียมมาตรฐาน (RSI oversold = 30, static)
2. user preset      ผู้ใช้ตั้งใหม่ทั้งระบบ — เก็บใน alert_label_prefs
3. per-rule         ปรับเฉพาะ rule นั้นใน modal — เก็บใน AST ของ rule เอง
```

```sql
CREATE TABLE alert_label_prefs (
  indicator    TEXT NOT NULL,
  concept      TEXT NOT NULL,
  calibration  TEXT NOT NULL,          -- 'static' | 'adaptive' | 'regime'
  params_json  TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (indicator, concept)
);
```

ตั้งครั้งเดียวว่า "ฉันถือว่า oversold คือ adaptive p10" แล้วทุก rule ใหม่ใช้ตามนั้น
โดยยังปรับรายตัวได้ modal แสดง badge เล็ก ๆ ว่าค่านี้มาจากชั้นไหน (`DEFAULT` / `YOURS` / `THIS RULE`)

### 8.5.4 Polarity เป็นบริบท ไม่ใช่ความจริง

`polarity: "bullish"` ของ oversold ถูกเฉพาะกับคนเล่น mean-reversion
คนเล่น momentum เห็น oversold แล้วอ่านว่า "อ่อนแอ" ซึ่งเป็น bearish

ดังนั้น:

- **ห้ามเอา polarity ไปรวมเป็นคะแนนอัตโนมัติ** ต่างจาก `score` ใน `watchlist_signals.py`
  ที่บวก/ลบตาม flag — ตรงนั้นเป็น heuristic แยกส่วน ปล่อยไว้ได้ แต่ alert engine ไม่ควรทำแบบนั้น
- polarity ใช้แค่ 2 อย่าง: สีของ chip ใน UI และการเรียงลำดับใน dropdown
- **เจตนาอยู่ที่ rule ไม่ใช่ที่ label** — ผู้ใช้ตั้งชื่อ rule ว่า "Oversold Bounce" เอง
  ระบบไม่เดาว่า rule นี้เป็นสัญญาณซื้อหรือขาย มี field `bias?: "long" | "short" | "info"`
  ให้ผู้ใช้กรอกเองถ้าต้องการให้ ticker แสดงสี

### 8.5.5 ความโปร่งใส และการ freeze ความหมาย

**label ต้องไม่เป็นกล่องดำ** ทุกที่ที่แสดง label ต้องแสดงสูตรที่ compile ออกมาจริงควบคู่เสมอ —
`desc` เป็น expression ที่ generate จาก AST ไม่ใช่ prose ที่เขียนมือแล้วหลุดจากโค้ด

```
Oversold  ·  RSI(14) <= 30                              [DEFAULT]
          ·  NVDA ตอนนี้ 41.2 — percentile 34 ในรอบปี
          ·  ยิง 6 ครั้งใน 250 แท่ง (ล่าสุด 2026-05-19)
```

บรรทัดที่ 2–3 สำคัญพอ ๆ กับบรรทัดแรก: มันเปลี่ยน label จากคำที่ต้องเชื่อ
เป็นตัวเลขที่ตรวจสอบได้ทันทีว่าเหมาะกับหุ้นตัวนี้ไหม

**Freeze ตอน save:** label resolve เป็น AST ตอนกด SAVE ไม่ใช่ตอน evaluate
เก็บที่มาไว้ใน `origin`:

```ts
origin: {
  kind: "label",
  indicator: "rsi",
  concept: "oversold",
  calibration: { mode: "static" },
  labelParams: { th: 30 },
  defVersion: 3,          // เวอร์ชันของนิยามตอนที่ save
}
```

เหตุผล: ถ้า resolve ตอน evaluate แล้ววันหนึ่งมีคนแก้ default จาก 30 เป็น 25
rule ทุกอันของผู้ใช้จะเปลี่ยนความหมายเงียบ ๆ โดยไม่มีใครรู้ — ยอมรับไม่ได้

แต่ก็ไม่ควรตกขบวนถาวร: เมื่อ `LABEL_DEFS_VERSION` ปัจจุบัน > `defVersion` ที่เก็บไว้
เปิด rule มาแก้จะเห็นแถบ

```
⚠ นิยาม "RSI Oversold" อัปเดตแล้ว (30 → 25)
  [ดูส่วนต่าง]  [ใช้นิยามใหม่]  [คงของเดิม]
```

`origin` ยังทำให้ UI แสดงกลับเป็น chip "RSI Oversold" ได้แทน raw compare (§9)

### 8.5.6 Label quality gate

label ที่ยิงบ่อยเกินไปไม่ใช่สัญญาณ มันคือ noise ที่ตั้งชื่อไว้เท่ ๆ
ทุก label ที่เพิ่มเข้า registry ต้องผ่าน calibration test:

```python
# backend/tests/test_label_calibration.py
# รัน label ทุกตัวกับ basket อ้างอิง 100 symbol × 5 ปี
#   base rate < 0.5%  → เข้มเกินไป แทบไม่เคยยิง ตรวจสูตร
#   base rate > 15%   → หลวมเกินไป ไม่ใช่สัญญาณ
#   ต้องมี symbol อย่างน้อย 80% ที่ยิงอย่างน้อย 1 ครั้ง (ไม่งั้นแปลว่า threshold ไม่ generalize)
```

test นี้จับปัญหาที่ review ด้วยตาไม่มีทางจับได้ เช่น squeeze ที่ใช้ค่าดิบแทน percentile
แล้วยิงเฉพาะหุ้นราคาต่ำ และมันเป็นหลักฐานเชิงตัวเลขว่านิยาม default ที่เลือกไว้สมเหตุสมผล

---

## 9. Frontend

### ไฟล์

```
components/bloomberg/alerts/
├── AlertRuleModal.tsx      # modal หลัก
├── RuleBuilder.tsx         # tree editor (recursive)
├── ConditionRow.tsx        # predicate หนึ่งบรรทัด
├── LabelPicker.tsx         # dropdown label + param inline
├── OperandPicker.tsx       # indicator/output/price/const/pctRank
├── RulePreviewPanel.tsx    # ผล dry-run
└── AlertRuleList.tsx       # จัดการ rule ทั้งหมด

lib/alerts/
├── ast.ts                  # types (แชร์กับ backend ผ่าน JSON schema)
├── concepts.ts             # LabelConcept + CONCEPT_META (§8.5.1)
├── calibrate.ts            # resolve label + calibration -> RuleNode (§8.5.2)
├── normalize.ts            # NNF + flatten + validate (รันฝั่ง client ด้วยเพื่อ instant feedback)
├── describe.ts             # AST -> "RSI(14) Oversold AND RVOL Spike"
└── text-parser.ts          # text mode (§10)

components/bloomberg/hooks/
├── useAlertRules.ts
└── useAlertEvents.ts
```

### หน้าตา modal (โทน Bloomberg เดิม: mono, dense, uppercase, border 1px)

```
┌─ ALERT RULE ─────────────────────────────────────── [×] ┐
│ NAME [Oversold Bounce Setup      ]  ENABLED [✓]  1D ▾   │
│ SCOPE  ( ) WATCHLIST (12)   (•) SYMBOLS [NVDA AMD +]    │
├──────────────────────────┬──────────────────────────────┤
│ CONDITIONS               │ PREVIEW                      │
│ ┌ [AND]▾ ──────────────┐ │ MATCHING NOW        2 / 12   │
│ │ [ ] NOT              │ │  ▸ NVDA   RSI 28.4  RVOL 2.1 │
│ │ RSI ▾ (14)           │ │  ▸ AMD    RSI 29.9  RVOL 3.4 │
│ │ [LABEL|custom]       │ │                              │
│ │ Oversold ▾  th [30]  │ │ FIRES / 250 BARS       41    │
│ │──────────────────────│ │ avg 3.4 per symbol / yr      │
│ │ RVOL ▾ (20)          │ │                              │
│ │ [label|CUSTOM]       │ │ ⚠ ไม่มี                       │
│ │ [rvol ▾][>=][2.0]    │ │                              │
│ │──────────────────────│ │ COMPILED                     │
│ │ ┌ [OR]▾ ───────────┐ │ │ RSI(14) <= 30                │
│ │ │ MACD bullCross   │ │ │  AND RVOL(20).rvol >= 2      │
│ │ │ EMA priceAbove   │ │ │  AND (MACD(12,26,9) bullCross│
│ │ └──────────────────┘ │ │       OR close > EMA(50))    │
│ │ [+ CONDITION] [+ GRP]│ │                              │
│ └──────────────────────┘ │ [TEXT MODE]                  │
├──────────────────────────┴──────────────────────────────┤
│ TRIGGER (•)EDGE ( )LEVEL   COOLDOWN [1] bars            │
│ NOTIFY [✓]TICKER [✓]TOAST [ ]SOUND [ ]WEBHOOK           │
│                                  [CANCEL]  [SAVE RULE]  │
└─────────────────────────────────────────────────────────┘
```

### รายละเอียด interaction ที่สำคัญ

- **`ConditionRow` มีสองโหมด** — สลับได้ตลอดเวลา ไม่ล็อก
  - `LABEL`: เลือก indicator → เลือก label → ปรับ param ของ label inline
  - `CUSTOM`: `[operand] [comparator] [operand]` โดย operand ขวาจะเป็น const, indicator อื่น
    หรือราคาก็ได้ → เขียน `close crossesBelow EMA(200)` ได้ตรง ๆ
  - **สลับ LABEL → CUSTOM ได้เสมอ** (expand template ให้เห็น) แต่ CUSTOM → LABEL ได้เฉพาะเมื่อ
    AST ตรงกับ template เป๊ะ (เทียบด้วย canonical form) — ไม่ตรงก็อยู่ CUSTOM ต่อไป ไม่ต้องเตือนอะไร
- **`origin` field** ทำให้เปิด rule เก่ามาแก้แล้วยังเห็นเป็น chip "RSI Oversold" ไม่ใช่ raw compare
- **`range` จาก `outputs`** กำหนด min/max ของ input threshold อัตโนมัติ — RSI ได้ 0–100,
  ส่วน output ที่ `unbounded` (ราคา/volume) modal จะเสนอ `pctRank` ให้แทนพร้อมเหตุผลสั้น ๆ
- **AND/OR toggle อยู่ที่หัวกลุ่ม** ไม่ใช่ระหว่างบรรทัด — กันเคส `A AND B OR C` ที่กำกวม
  ทุกกลุ่มมี operator เดียวเสมอ ต้องการผสมก็ซ้อนกลุ่ม (บังคับ well-formed by construction)
- **NOT เป็น checkbox ต่อบรรทัด/ต่อกลุ่ม** ไม่ใช่ node ที่ผู้ใช้ต้องสร้างเอง
- **preview อัปเดตแบบ debounce ~400ms** ทุกครั้งที่ AST เปลี่ยน
- **contradiction → ปุ่ม SAVE disabled** พร้อมชี้บรรทัดที่ขัดกัน

### จุดเชื่อมของเดิม

- `components/bloomberg/layout/alert-ticker.tsx` — เพิ่ม event source จาก `/api/alerts/events`
  (ปัจจุบันมีแค่ stoploss + regime)
- `components/bloomberg/core/watchlist.tsx` — เพิ่มไอคอนกระดิ่ง + badge จำนวน rule ที่ยิงอยู่ต่อแถว
  คลิกเปิด modal พร้อม scope = symbol นั้น
- `terminal/registry.ts` — เพิ่มคำสั่ง `ALERT` / `ALERT NEW` / `ALERT LIST` ตาม pattern เดิม

---

## 10. Text mode (ทางเลือกขั้นสูง)

โปรเจกต์มี lexer→parser→validator→registry อยู่แล้วใน `components/bloomberg/terminal/`
ยืม pattern มาทำ mini expression language ที่ parse เป็น **AST ตัวเดียวกัน**:

```
RSI(14) <= 30 AND RVOL(20) >= 2 AND WITHIN 3 BARS (MACD CROSSES_ABOVE SIGNAL)
```

round-trip ได้ทั้งสองทาง (`describe.ts` แปลง AST → text, `text-parser.ts` แปลงกลับ)
เพราะมันคือ representation เดียวกัน — คนที่ชอบพิมพ์กับคนที่ชอบคลิกใช้ระบบเดียวกัน
ไม่ต้องมี evaluator สองชุด

ไม่จำเป็นสำหรับ v1 แต่ควรออกแบบ AST ให้รองรับตั้งแต่แรก (ซึ่งข้างบนรองรับแล้ว)

---

## 11. ลำดับการทำ

| Phase | ได้อะไร |
|---|---|
| **1** | `ast.ts` + `normalize.ts` + `eval.py` + unit test ครบ (AST → boolean series) — ไม่มี UI |
| **2** | ตาราง DB + CRUD router + `engine.py` (trigger/cooldown/state) + scan endpoint |
| **3** | `concepts.ts` (คำศัพท์กลาง) + `outputs`/`alertLabels` ใน registry — เริ่มจาก RSI, MACD, EMA, RVOL, Bollinger + calibration test (§8.5.6) |
| **4** | Modal + RuleBuilder (label mode อย่างเดียวก่อน) |
| **5** | Custom compare mode + preview panel |
| **6** | ต่อเข้า alert-ticker + badge ใน watchlist + scheduler |
| **7** | (option) text mode, webhook, intraday timeframe |

Phase 1–2 ทดสอบได้เต็มที่โดยไม่ต้องแตะ UI เลย ซึ่งเป็นส่วนที่พังง่ายที่สุดและแก้แพงที่สุด
