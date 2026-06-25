# Bloomberg Terminal — Claude Instructions

> **Start every session by reading [`memory/project_summary.md`](memory/project_summary.md)**
> It contains the full picture: features, architecture, all key files, env vars, run commands, and known issues.

## Quick reference

```bash
# Backend (Terminal 1) — macOS/Linux
cd backend
# env vars are in backend/.env — loaded automatically by python-dotenv
python -m uvicorn main:app --port 8000 --reload

# Backend (Terminal 1) — Windows PowerShell
cd backend
python -m uvicorn main:app --port 8000 --reload

# Frontend (Terminal 2)
npm run dev   # → http://localhost:3000
```

## Rules
- Never fetch Yahoo Finance directly from Next.js — always go through the Python backend
- Never reintroduce `@upstash/redis`, `yahoo-finance2`, or any top-level scheduler singleton
- Backend is modular: `main.py` (app init) + `config.py` + `db.py` + `routers/*.py`
- State lives in Jotai atoms (`components/bloomberg/atoms/index.ts`) + React Query for server data

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

### Add a new tab inside macro-view (or any tabbed view)
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

## Views (9 views, post-RMI removal 2026-05-24)

| Key | Button | View | Content |
|-----|--------|------|---------|
| `1` | MKT   | market-view    | Watchlist · Chart · Global indices ticker |
| `2` | NEWS  | news-view      | Financial news · Facebook social feed · Polymarket column (right 256px) |
| `3` | GMOV  | market-movers  | Global indices table · Heatmap treemap |
| `4` | CLIP  | clippings-view | Obsidian markdown notes · Ollama AI |
| `5` | MACRO | macro-view     | 7 tabs: dashboard, yield, indicators, fed, country, compare, signals |
| `6` | CRDT  | credit-view    | 4 tabs: overview, spreads, stress, consumer |
| `P` | PORT  | portfolio-view | 5 top-level: PORTFOLIO (sub: POSITIONS·OPTIONS·TRADES·CASH) · ANALYTICS (sub: P&L·BACKTEST) · RISK · TOOLS (sub: THESES·IMPORT) · PAPER (sub: DASHBOARD·TRADE·POSITIONS·OPTIONS·HISTORY) |
| `C` | CRYP  | crypto-view    | 20 crypto coins · Chart |
| `E` | FX    | fx-view        | 20 FX pairs · Chart |

**Removed:** GVOL (fake `Math.random()` data), EQTY (duplicates MKT search), RMI (removed 2026-05-24)  
**Stock analysis** (9 tabs: financials, options, etc.) still accessible from global search / heatmap click  
**Country/sovereign data** → use MACRO [6] → COUNTRY tab (was in CRDT sovereign, now consolidated)

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
├── project_summary.md     ← slim core: stack, env vars, 26 routers, DB schema, 9 views, known issues
├── reference/
│   ├── architecture.md         ← data flow, key files, 26 routers table
│   ├── api-endpoints.md        ← all endpoints + caching strategy + Next.js proxy routes
│   ├── frontend-structure.md   ← full component tree + key exports + keyboard shortcuts
│   ├── data-shapes.md          ← API response shapes (avoid reading router files)
│   └── data-catalog.md         ← 17 data categories available for analysis
├── plans/                 ← feature plans (active + completed/)
└── sessions/              ← audit trail + reports
```

**Before writing any file in `memory/`: read `memory/AGENTS.md` for format rules.**
