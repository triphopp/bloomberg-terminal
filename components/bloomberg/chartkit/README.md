# chartkit

Our own charting library. Started as the home for the "zoom out, get more
history" logic, and is the folder a hand-written candlestick renderer would
grow in.

## The one rule

```
chartkit/*.ts          → pure. No React, no lightweight-charts, no fetch.
chartkit/adapters/*.ts → the ONLY place a rendering engine may be imported.
```

Everything the library *decides* lives in the pure core, so it survives an
engine swap. Everything that *touches a chart instance* lives in an adapter, so
an engine swap is one new file.

React hooks do not live here either — they belong next to the components that
use them (`components/bloomberg/chart/useAutoExtendRange.ts` is the consumer of
this folder).

## What's in it

| File | What |
|------|------|
| `types.ts` | `LogicalRange` (bar indices, may run negative into whitespace), `TimeRange`, `ViewportSample` |
| `range-ladder.ts` | Order history windows by span; `nextWider` returns the rung above the current one |
| `auto-extend.ts` | `needsExtend` — is the viewport's left edge at the oldest loaded bar? `planExtend` — which window to load next |
| `adapters/lightweight-charts.ts` | Debounced visible-range subscription; capture/restore the viewport in TIME across a rebuild |

## Why time, not bar indices, when restoring a viewport

Extending history prepends bars, so index 0 stops meaning the same bar. Restore
a *logical* range after a fetch and the user is silently thrown backwards by
however many bars arrived. The time range they were looking at survives.

## Tests

```bash
npm run test:chart
```

The pure modules are covered directly (`__tests__/`). The adapter is not — it is
a thin wrapper over engine calls with nothing to assert that would not just be
restating the engine's API.
