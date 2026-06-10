# Terminal Command System — Architecture

```
Input string
    │
    ▼
┌─────────┐
│  Lexer  │  tokenize(raw) → Token[]
└─────────┘
    │
    ▼
┌────────┐
│ Parser │  parse(raw) → ParseResult (AstNode | error)
└────────┘
    │
    ▼
┌───────────┐
│ Validator │  validate(result) → ParseResult (checks arg count/types)
└───────────┘
    │
    ▼
┌──────────┐
│ Registry │  CMD_MAP.get(fn) → CommandDef
└──────────┘
    │
    ▼
┌──────────┐
│ Executor │  executeAst(ast, ctx, signal) → Promise<CommandResult>
└──────────┘
    │
    ▼
┌──────────────┐
│ ResultPanel  │  render scalar / table / info in overlay
└──────────────┘
```

---

## Files

```
components/bloomberg/terminal/
├── types.ts        Token, AstNode, CommandDef, CommandResult, TerminalCtx
├── lexer.ts        tokenize() — string → Token[]
├── parser.ts       parse()    — Token[] → AstNode
├── validator.ts    validate() — check arg count + types
├── registry.ts     ALL_COMMANDS, CMD_MAP — command definitions + handlers
├── executor.ts     executeAst() — dispatch to handler, AbortController-safe
├── autocomplete.ts getSuggestions(), isCommandInput()
└── index.ts        public re-exports

backend/routers/analytics.py   Python endpoints (/api/analytics/*)
app/api/analytics/route.ts     Next.js proxy (20s timeout)
```

---

## Lexer (`lexer.ts`)

Input: raw string  
Output: `Token[]`

Token kinds:
| Kind | Example | Note |
|------|---------|------|
| `IDENT` | `CORR`, `AAPL`, `^GSPC`, `BTC-USD` | normalized to uppercase |
| `LPAREN` | `(` | |
| `RPAREN` | `)` | |
| `COMMA` | `,` | |
| `NUMBER` | `14`, `252` | parsed as float |
| `PERIOD_VAL` | `3m`, `1y`, `5d` | digit + d/w/m/y suffix |
| `EOF` | — | always appended |

Symbol chars allowed in IDENT: `[A-Za-z0-9^.\-_=]`  
Examples: `^GSPC`, `BTC-USD`, `GC=F`, `SCB.BK`

---

## Parser (`parser.ts`)

Recursive descent. Input: `Token[]`. Output: `ParseResult`:

```typescript
type ParseResult =
  | { ok: true;  ast: AstNode }
  | { ok: false; error: string }
```

AstNode shapes:

```typescript
// Function call: corr(AAPL, MSFT, 3m)
{ kind: "call", fn: "CORR", args: ArgValue[] }

// Navigation/setting: MKT, ALERT OFF
{ kind: "nav" | "set", cmd: "MKT" | "ALERT OFF" | ... }

// Symbol lookup: AAPL (not a command)
{ kind: "lookup", symbol: "AAPL" }
```

`ArgValue`:
```typescript
{ type: "symbol",  value: "AAPL"  }
{ type: "period",  value: "3m"    }
{ type: "number",  value: 14      }
```

---

## Validator (`validator.ts`)

Runs after parse. Checks:

1. **Unknown function** — `CMD_MAP.has(fn)` → error with suggestion
2. **Too few args** — `args.length < required_count` → error with usage hint
3. **Too many args** (non-variadic) — error
4. Pass through nav/set/lookup unchanged

Variadic detection: `def.args?.some(a => a.name.includes("..."))`  
Used by: `compare(A, B, C, ...)`, `rank(A, B, ..., METRIC?)`

---

## Registry (`registry.ts`)

Central command store. Each `CommandDef`:

```typescript
interface CommandDef {
  name:        string;           // e.g. "CORR", "ALERT OFF"
  aliases?:    string[];         // e.g. ["COR"]
  group:       CommandGroup;     // "analysis" | "nav" | "setting" | "info"
  description: string;
  args?:       ArgDef[];         // parameter schema
  handler:     CommandHandler;   // async function
}
```

`CommandHandler` signature:
```typescript
type CommandHandler = (
  args:   ResolvedArgs,
  ctx:    TerminalCtx,
  signal: AbortSignal,
) => Promise<CommandResult>
```

`TerminalCtx` — injected by `global-search.tsx`:
```typescript
interface TerminalCtx {
  setView:          (v: string) => void;
  setTickerEnabled: (v: boolean) => void;
  setDarkMode:      (v: boolean) => void;
  setShowYTD:       (v: boolean) => void;
  setStockSymbol:   (s: string) => void;
  invalidate:       (key: string) => void;  // React Query cache bust
  close:            () => void;             // close overlay
}
```

`CMD_MAP`: `Map<string, CommandDef>` — keyed on name + all aliases  
`ALL_COMMANDS`: `CommandDef[]` — for autocomplete enumeration

---

## Executor (`executor.ts`)

```typescript
async function executeAst(
  ast:    AstNode,
  ctx:    TerminalCtx,
  signal: AbortSignal,
): Promise<CommandResult>
```

Dispatch logic:
1. `kind === "call"` → `CMD_MAP.get(ast.fn).handler(ast.args, ctx, signal)`
2. `kind === "nav"` | `"set"` → `CMD_MAP.get(ast.cmd).handler([], ctx, signal)`
3. `kind === "lookup"` → `ctx.setStockSymbol(symbol); ctx.setView("stock"); return {kind:"navigate"}`
4. `AbortError` caught → `{kind:"error", message:"Cancelled"}` (silent)

---

## Autocomplete (`autocomplete.ts`)

`isCommandInput(raw)`:
- Empty → false
- Contains `(` → true (function call in progress)
- First word **exact match** in `CMD_FIRST_WORDS` Set → true
- Otherwise → false (stock search mode)

`getSuggestions(raw)`:
- Inside `(` → arg hints (period choices or `<SYMBOL>` placeholder)
- Top-level → prefix-match ALL_COMMANDS, sorted by GROUP_SORT
  - analysis=0, nav=1, setting=2, info=3

---

## AbortController Pattern (anti-stale-result)

```typescript
// In global-search.tsx
const abortRef = useRef<AbortController>(new AbortController());

async function runCommand(query: string) {
  abortRef.current.abort();                    // cancel previous
  abortRef.current = new AbortController();    // fresh controller
  const { signal } = abortRef.current;

  // ... parse → validate ...
  const result = await executeAst(ast, ctx, signal);
  if (signal.aborted) return;                  // discard stale result
  setExecResult(result);
}
```

Handler passes `signal` to `fetch()` calls — network request cancelled too.

---

## Backend Analytics (`analytics.py`)

Python FastAPI router. Pattern per endpoint:

```python
@router.get("/api/analytics/corr")
def get_corr(a: str, b: str, period: str = "3m"):
    key = f"corr:{a}:{b}:{period}"
    return _cache.get_or_set(key, lambda: _compute_corr(a, b, period), ttl=300)
```

Key design choices:
- `def` (not `async def`) — yfinance is blocking I/O, runs in ThreadPoolExecutor
- `TTLCache.get_or_set()` — stampede prevention via per-key `threading.Event`
- `ttl=300` — 5-minute cache per (symbol, period) combo
- `auto_adjust=True` in yf.download — dividend/split adjusted

---

## Result Types

```typescript
type CommandResult =
  | { kind: "navigate" }          // closed overlay, navigated
  | { kind: "action" }            // setting applied, overlay closed
  | { kind: "stay"; content?: ResultContent }   // show result in overlay
  | { kind: "display"; content: ResultContent } // show result, keep overlay
  | { kind: "error"; message: string }
```

`ResultContent` rendered in `ResultPanel`:

```typescript
// Single value (e.g. corr, beta, sharpe)
{ type: "scalar"; label: string; value: string; sub?: string }

// Multi-row (e.g. compare, rank)
{ type: "table"; label: string; cols: string[]; rows: RowData[] }

// Text lines (e.g. HELP, REGIME)
{ type: "info"; label: string; lines: string[] }
```

`RowData`:
```typescript
{ cells: string[]; color?: "pos" | "neg" | "" }
```

---

## Concurrency Safety

| Risk | Solution |
|------|---------|
| Two users hit same yfinance endpoint | TTLCache per-key Event — only 1 thread computes, others wait |
| User types fast → multiple in-flight fetches | AbortController — old request cancelled before new starts |
| Stale result renders after new query | `if (signal.aborted) return` guard before `setExecResult` |
| Cache stampede on cold start | `get_or_set()` Event pattern in cache.py |
| Thread safety on TTLCache dict | `threading.Lock` wraps all mutating operations |
