import assert from "node:assert/strict";
import test from "node:test";
import {
  type RawSviFit,
  buildIvSmile,
  buildIvSmileOi,
  chooseSmileExpiry,
  expiryDays,
  selectSmileTenors,
  smilePlotRows,
  smileSamples,
  smileTenorDate,
  smileWingMetrics,
  sviIvAtStrike,
} from "../iv-smile.ts";

const quote = (strike: number, impliedVolatility = 0.25, bid = 1, ask = 2) => ({
  strike,
  impliedVolatility,
  bid,
  ask,
});

test("select one expiry nearest30 days, avoid <7 DTE by default and break ties earlier", () => {
  const expirations = ["2026-11-01", "2026-10-13", "2026-09-14", "2026-10-11"];
  assert.equal(chooseSmileExpiry(expirations, "2026-09-13"), "2026-10-13");
  assert.equal(chooseSmileExpiry(["2026-10-14", "2026-10-12"], "2026-09-13"), "2026-10-12");
  assert.equal(chooseSmileExpiry(["2026-09-14", "2026-11-01"], "2026-09-13"), "2026-11-01");
  assert.equal(chooseSmileExpiry(["2026-09-14", "2026-09-16"], "2026-09-13"), "2026-09-16");
  assert.equal(chooseSmileExpiry(["bad", "2026-09-12"], "2026-09-13"), undefined);
  assert.equal(chooseSmileExpiry([], "2026-09-13"), undefined);
  assert.equal(expiryDays("2026-10-13", "2026-09-13"), 30);
  assert.deepEqual(expirations, ["2026-11-01", "2026-10-13", "2026-09-14", "2026-10-11"]);
});

test("union includes put-only and call-only strikes with numeric K and percent IV", () => {
  const result = buildIvSmile({
    spot: 100,
    calls: [quote(120, 0.35), quote(100, 0.25)],
    puts: [quote(100, 0.3), quote(95, 0.4)],
  });
  assert.deepEqual(result.points, [
    { strike: 95, callIV: null, putIV: 40 },
    { strike: 100, callIV: 25, putIV: 30 },
    { strike: 120, callIV: 35, putIV: null },
  ]);
  assert.equal(result.sufficient, true);
  assert.equal(result.callCount, 2);
  assert.equal(result.putCount, 2);
});

test("invalid IV stays missing, including Yahoo's tiny floor; no fake zero or NaN curve", () => {
  const result = buildIvSmile(
    {
      spot: 100,
      calls: [
        quote(95, 0),
        quote(100, 1e-5),
        quote(105, Number.NaN),
        quote(110, Number.POSITIVE_INFINITY),
        quote(-10),
      ],
      puts: [quote(100, 0.25)],
    },
    25,
    false
  );
  assert.equal(result.callCount, 0);
  assert.equal(result.putCount, 1);
  assert.equal(result.excluded, 4);
  assert.equal(result.sufficient, false);
  assert.ok(result.points.every((p) => p.callIV === null));
});

test("quote filter rejects zero/missing/crossed quotes and ALL IV can inspect them", () => {
  const chain = {
    spot: 100,
    puts: [],
    calls: [
      quote(90, 0.3, 0, 1),
      quote(95, 0.3, 2, 1),
      { strike: 100, impliedVolatility: 0.3 },
      quote(105, 0.3, 1, 1),
    ],
  };
  assert.equal(buildIvSmile(chain).callCount, 1);
  assert.equal(buildIvSmile(chain).excluded, 3);
  assert.equal(buildIvSmile(chain, 25, false).callCount, 4);
});

test("range endpoints are included and changing range never rescales strike or IV", () => {
  const chain = {
    spot: 100,
    puts: [],
    calls: [quote(70), quote(75), quote(100), quote(125), quote(140)],
  };
  assert.deepEqual(
    buildIvSmile(chain).points.map((p) => p.strike),
    [75, 100, 125]
  );
  assert.equal(buildIvSmile(chain, 50).callCount, 5);
  assert.equal(buildIvSmile(chain, 0).callCount, 5);
  assert.equal(buildIvSmile({ ...chain, spot: 0 }).callCount, 5);
});

test("require three distinct valid strikes; empty and duplicated rows cannot fabricate a smile", () => {
  assert.equal(buildIvSmile({ spot: 100, calls: [], puts: [] }).sufficient, false);
  const result = buildIvSmile({
    spot: 100,
    calls: [quote(100), quote(100), quote(105)],
    puts: [quote(100), quote(105)],
  });
  assert.equal(result.strikeCount, 2);
  assert.equal(result.sufficient, false);
});

test("tenors use calendar months and clamp month-end including leap years", () => {
  assert.equal(smileTenorDate(1, "2026-01-31"), "2026-02-28");
  assert.equal(smileTenorDate(1, "2028-01-31"), "2028-02-29");
  assert.equal(smileTenorDate(3, "2026-11-30"), "2027-02-28");
  assert.equal(smileTenorDate(9, "2026-09-13"), "2027-06-13");
});

test("multiple tenors map to actual contracts, sorted and deduplicated", () => {
  const result = selectSmileTenors(
    ["2027-06-18", "2026-09-14", "2026-10-16", "2026-12-18", "2027-02-19", "2027-04-16"],
    [9, 1, 3, 5, 7, 1],
    "2026-09-13"
  );
  assert.deepEqual(
    result.map((r) => r.expiry),
    ["2026-10-16", "2026-12-18", "2027-02-19", "2027-04-16", "2027-06-18"]
  );
  assert.equal(result[0].days, 33);
  assert.deepEqual(selectSmileTenors(["2026-11-13"], [1, 3], "2026-09-13"), [
    { months: [1, 3], expiry: "2026-11-13", days: 61 },
  ]);
});

test("missing distant tenor is unavailable; ties choose earlier actual expiry", () => {
  assert.deepEqual(
    selectSmileTenors(["bad", "2026-09-14", "2026-10-12", "2026-10-14"], [1, 9], "2026-09-13"),
    [
      { months: [1], expiry: "2026-10-12", days: 29 },
      { months: [9], expiry: null, days: null },
    ]
  );
  assert.deepEqual(selectSmileTenors([], [1], "2026-09-13"), [
    { months: [1], expiry: null, days: null },
  ]);
});

test("OTM uses put wing below spot and call wing at/above spot without filling missing quotes", () => {
  const points = [
    { strike: 90, callIV: 99, putIV: 31 },
    { strike: 95, callIV: 99, putIV: null },
    { strike: 100, callIV: 25, putIV: 99 },
    { strike: 110, callIV: 27, putIV: 99 },
  ];
  assert.deepEqual(smileSamples(points, "otm", 100), [
    {
      name: "otm",
      points: [
        { strike: 90, ivPercent: 31 },
        { strike: 100, ivPercent: 25 },
        { strike: 110, ivPercent: 27 },
      ],
    },
  ]);
  assert.deepEqual(smileSamples(points, "otm", 0), [{ name: "otm", points: [] }]);
  const both = smileSamples(points, "both", 100);
  assert.equal(both[0].points.length, 4);
  assert.equal(both[1].points.length, 3);
});

test("observed 25-delta skew and butterfly use each wing's IV in spot delta", () => {
  const z = 0.67448975;
  const callIv = 30;
  const putIv = 40;
  const callStrike = 100 * Math.exp(z * 0.3 + 0.3 ** 2 / 2);
  const putStrike = 100 * Math.exp(-z * 0.4 + 0.4 ** 2 / 2);
  const metrics = smileWingMetrics(
    [
      { strike: putStrike, callIV: null, putIV: putIv },
      { strike: 100, callIV: 25, putIV: 25 },
      { strike: callStrike, callIV: callIv, putIV: null },
    ],
    100,
    1
  );
  assert.equal(metrics.call25, callIv);
  assert.equal(metrics.put25, putIv);
  assert.equal(metrics.atm, 25);
  assert.equal(metrics.skew, -10);
  assert.equal(metrics.curvature, 10);
});

test("25-delta metrics interpolate within observed wings and never extrapolate", () => {
  const metrics = smileWingMetrics(
    [
      { strike: 80, callIV: null, putIV: 45 },
      { strike: 90, callIV: null, putIV: 35 },
      { strike: 100, callIV: 25, putIV: 25 },
      { strike: 120, callIV: 30, putIV: null },
      { strike: 150, callIV: 40, putIV: null },
    ],
    100,
    1
  );
  assert.ok(metrics.call25 != null && metrics.call25 > 30 && metrics.call25 < 40);
  assert.ok(metrics.put25 != null && metrics.put25 > 35 && metrics.put25 < 45);
  assert.ok(metrics.skew != null && Number.isFinite(metrics.skew));
  assert.ok(metrics.curvature != null && Number.isFinite(metrics.curvature));

  const sparse = smileWingMetrics(
    [
      { strike: 100, callIV: 25, putIV: 25 },
      { strike: 105, callIV: 30, putIV: null },
      { strike: 110, callIV: 30, putIV: null },
    ],
    100,
    1
  );
  assert.equal(sparse.call25, null);
  assert.equal(sparse.put25, null);
  assert.equal(sparse.skew, null);
  assert.equal(sparse.curvature, null);
  assert.equal(smileWingMetrics([], 100, 0).skew, null);

  const gapAtSpot = smileWingMetrics(
    [
      { strike: 90, callIV: null, putIV: 40 },
      { strike: 100, callIV: null, putIV: null },
      { strike: 110, callIV: 20, putIV: null },
    ],
    100,
    1
  );
  assert.equal(gapAtSpot.atm, 30);
});

const fit: RawSviFit = {
  status: "ok",
  reason: null,
  parameters: { a: 0.02, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
  rmseIvPct: 0,
  usedPoints: 12,
  minStrike: 80,
  maxStrike: 120,
  referencePrice: 100,
  timeYears: 0.5,
};

test("SVI renders total variance as IV percent and does not extrapolate or draw failed fits", () => {
  const atmIv = sviIvAtStrike(100, fit);
  assert.ok(atmIv != null);
  assert.ok(Math.abs(atmIv - 100 * Math.sqrt(0.03 / 0.5)) < 1e-10);
  assert.equal(sviIvAtStrike(79, fit), null);
  assert.equal(sviIvAtStrike(121, fit), null);
  assert.equal(sviIvAtStrike(100, { ...fit, timeYears: 0 }), null);
  assert.equal(sviIvAtStrike(100, { ...fit, status: "unavailable", parameters: null }), null);
  assert.ok((sviIvAtStrike(80, fit) ?? 0) > 0);
  assert.ok((sviIvAtStrike(120, fit) ?? 0) > 0);
});

test("maturity curves share numeric K grid while quotes remain at their actual strikes", () => {
  const series = [
    {
      id: "one",
      points: [
        { strike: 80, ivPercent: 30 },
        { strike: 120, ivPercent: 28 },
      ],
      fit,
    },
    {
      id: "three",
      points: [
        { strike: 100, ivPercent: 24 },
        { strike: 140, ivPercent: 25 },
      ],
      fit: { ...fit, minStrike: 100, maxStrike: 140 },
    },
  ];
  const rows = smilePlotRows(series, true);
  assert.ok(rows.length >= 181);
  const atm = rows.find((r) => r.strike === 100);
  assert.ok(atm);
  assert.equal(atm.one_observed, null);
  assert.equal(atm.three_observed, 24);
  assert.equal(atm.one_fit, atm.three_fit);
  assert.equal(rows[0].three_fit, null);
  assert.equal(rows.at(-1)?.one_fit, null);
  const observed = smilePlotRows(series, false);
  assert.deepEqual(
    observed.map((r) => r.strike),
    [80, 100, 120, 140]
  );
  assert.ok(observed.every((r) => r.one_fit === null && r.three_fit === null));
});

test("OI survives missing IV and unquoted contracts, independently of smile filters", () => {
  const chain = {
    spot: 100,
    calls: [
      { ...quote(90, 0, 0, 0), openInterest: 200 },
      { ...quote(100), openInterest: 0 },
    ],
    puts: [{ ...quote(110, Number.NaN, 0, 0), openInterest: 50 }],
  };
  assert.equal(buildIvSmile(chain).callCount, 1);
  assert.equal(buildIvSmile(chain).putCount, 0);
  const result = buildIvSmileOi(chain);
  assert.deepEqual(result.points, [
    { strike: 90, callOI: 200, putOI: null },
    { strike: 100, callOI: 0, putOI: null },
    { strike: 110, callOI: null, putOI: 50 },
  ]);
  assert.equal(result.callTotal, 200);
  assert.equal(result.putTotal, 50);
  assert.equal(result.putCallRatio, 0.25);
});

test("unknown OI does not become reported zero; partial totals cannot imply a P/C ratio", () => {
  const result = buildIvSmileOi({
    spot: 100,
    puts: [quote(100)],
    calls: [
      { ...quote(90), openInterest: 0, openInterestAvailable: false },
      { ...quote(100), openInterest: 10 },
      { ...quote(110), openInterest: -1 },
      { ...quote(115), openInterest: Number.NaN },
      { ...quote(120), openInterest: 1.5 },
    ],
  });
  assert.equal(result.callTotal, 10);
  assert.equal(result.putTotal, null);
  assert.equal(result.missing, 5);
  assert.equal(result.putCallRatio, null);
  assert.equal(result.points[0].callOI, null);
  const zero = buildIvSmileOi({ spot: 100, puts: [], calls: [{ ...quote(100), openInterest: 0 }] });
  assert.equal(zero.available, true);
  assert.equal(zero.callTotal, 0);
  assert.equal(zero.putCallRatio, null);
  assert.equal(buildIvSmileOi({ spot: 100, calls: [quote(100)], puts: [] }).available, false);
});

test("OI range includes endpoints and sums distinct contracts once per expiry", () => {
  const row = { ...quote(100), contractSymbol: "TESTC100", openInterest: 20 };
  const chain = {
    spot: 100,
    calls: [
      row,
      row,
      { ...row, contractSymbol: "TEST1C100", openInterest: 5 },
      { ...quote(75), openInterest: 10 },
      { ...quote(125), openInterest: 30 },
      { ...quote(150), openInterest: 1000 },
    ],
    puts: [],
  };
  const result = buildIvSmileOi(chain);
  assert.equal(result.callTotal, 65);
  assert.equal(result.points.find((r) => r.strike === 100)?.callOI, 25);
  assert.deepEqual(
    result.points.map((r) => r.strike),
    [75, 100, 125]
  );
  assert.equal(buildIvSmileOi(chain, 0).callTotal, 1065);
});

test("OI overlay uses exact observed strikes on fitted grid, no fitted OI or IV pollution", () => {
  const series = [
    {
      id: "one",
      points: [
        { strike: 80, ivPercent: 30 },
        { strike: 120, ivPercent: 28 },
      ],
      fit,
    },
  ];
  const rows = smilePlotRows(series, true, [
    { strike: 73, callOI: 5000, putOI: null },
    { strike: 100, callOI: 0, putOI: 40 },
  ]);
  assert.equal(rows[0].strike, 73);
  assert.equal(rows[0].callOI, 5000);
  assert.equal(rows[0].one_fit, null);
  assert.equal(rows[0].one_observed, null);
  assert.equal(rows.find((r) => r.strike === 100)?.callOI, 0);
  assert.equal(rows.filter((r) => r.callOI != null).length, 2);
  assert.equal(rows.filter((r) => r.one_observed != null).length, 2);
  assert.equal(
    smilePlotRows(series, true).some((r) => r.callOI != null),
    false
  );
});
