# legacy — the indicators before the columnar engine

Reference implementations for `../indicator-equivalence.test.ts` and
`../kernels.test.ts`. **Not used by the app.**

Each file is the indicator of the same name in `chart/indicators/` as it stood
at commit `ee69d21` (2026-10-12, the commit before the move to typed columns),
changed only where it had to be to live in this folder:

- import paths (`../types` → `../../types`, and so on);
- `bollinger.ts` / `bollinger-b.ts` take `calcBollingerStats` from
  `./bollinger-stats.ts`, which is that function as it was in
  `chart/bollinger-fit.ts`;
- `ichimoku.ts` colours and Chikou's `lineStyle`, restyled on purpose
  2026-10-23 together with the live indicator (style only, no value);
- three `biome-ignore` comments on non-null assertions (`ema.ts`, `volume.ts`),
  and whatever the formatter did when the files were committed.

No arithmetic, no condition and no point-building line was touched. To check:

```bash
git show ee69d21:components/bloomberg/chart/indicators/ema.ts | diff -w - components/bloomberg/chart/__tests__/legacy/ema.ts
```

They exist so that "no drawn value changed" is a test rather than a claim: the
new `compute()` of every converted indicator must return exactly what these
return, on every generated dataset. They are compared on the same machine, so
the result does not depend on how a platform rounds `Math.log`.

When an indicator's output is changed on purpose, change its file here in the
same commit — or delete it together with its entry in `LEGACY` once the
columnar version has been the only one long enough to be the reference itself.
