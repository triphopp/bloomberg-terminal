"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PayoffResult } from "./PayoffChart";

// The expiry payoff is arithmetic — max(S−K,0) and a subtraction — so it is
// computed here, in the browser, on every keystroke. No network, no latency,
// and no chance of disagreeing with the backend because there is no model to
// disagree about.
//
// The T+0 line and POP are Black-Scholes at live implied vol. Those live in
// `analytics/option_payoff.py` and are fetched debounced. Re-implementing
// Black-Scholes here to make them instant would put option pricing in two
// languages and let the chart drift away from the greeks in the positions
// table — the cost of a second copy is much higher than 400ms.

export interface PayoffLeg {
  underlying: string;
  expiry: string;
  strike: number;
  option_type: "call" | "put";
  quantity: number; // signed
  entry_price: number;
  multiplier: number;
  fees: number;
}

const intrinsic = (type: string, k: number, s: number) =>
  type === "call" ? Math.max(s - k, 0) : Math.max(k - s, 0);

const payoffAt = (legs: PayoffLeg[], s: number) =>
  legs.reduce(
    (acc, l) =>
      acc +
      (intrinsic(l.option_type, l.strike, s) - l.entry_price) * l.quantity * l.multiplier -
      l.fees,
    0
  );

/** Zero crossings by scan + bisection — a closed form only covers one leg. */
function breakevens(legs: PayoffLeg[], lo: number, hi: number, steps = 800) {
  const out: number[] = [];
  const step = (hi - lo) / steps;
  let prevS = lo;
  let prevV = payoffAt(legs, prevS);
  for (let i = 1; i <= steps; i++) {
    const s = lo + i * step;
    const v = payoffAt(legs, s);
    if (prevV * v < 0) {
      let a = prevS;
      let b = s;
      let fa = prevV;
      for (let k = 0; k < 50; k++) {
        const mid = (a + b) / 2;
        const fm = payoffAt(legs, mid);
        if (fa * fm <= 0) b = mid;
        else {
          a = mid;
          fa = fm;
        }
      }
      out.push((a + b) / 2);
    }
    prevS = s;
    prevV = v;
  }
  return out;
}

/** Local, expiry-only result. Same shape as the backend's so the chart takes either. */
export function localPayoff(legs: PayoffLeg[], spot: number, points = 121): PayoffResult | null {
  if (!legs.length || !(spot > 0)) return null;

  const strikes = legs.map((l) => l.strike).filter((k) => k > 0);
  const lo = Math.max(Math.min(spot * 0.65, ...strikes.map((k) => k * 0.92)), 0.01);
  const hi = Math.max(spot * 1.35, ...strikes.map((k) => k * 1.08));
  const step = (hi - lo) / Math.max(points - 1, 1);

  const curve = Array.from({ length: points }, (_, i) => {
    const s = lo + i * step;
    return { s: Number(s.toFixed(4)), expiry: Number(payoffAt(legs, s).toFixed(2)), t0: null };
  });

  // Only calls still move the payoff as the underlying runs away upward, so the
  // sign of their net size decides whether the tail is unbounded profit or
  // unbounded loss. Reading it off the grid's edge would report a number that
  // describes the chart width, not the position.
  const slopeUp = legs
    .filter((l) => l.option_type === "call")
    .reduce((a, l) => a + l.quantity * l.multiplier, 0);
  const candidates = [0, ...strikes, hi * 2];
  const vals = candidates.map((s) => ({ s, v: payoffAt(legs, s) }));
  const best = vals.reduce((a, b) => (b.v > a.v ? b : a));
  const worst = vals.reduce((a, b) => (b.v < a.v ? b : a));

  return {
    spot,
    currency: "USD",
    range: { min: lo, max: hi },
    curve,
    breakevens: breakevens(legs, 0.01, hi * 2).map((price) => ({
      price: Number(price.toFixed(4)),
      move_pct: Number(((price / spot - 1) * 100).toFixed(2)),
    })),
    max_profit:
      slopeUp > 1e-9
        ? {
            value: null,
            unbounded: true,
            at: null,
            note: "net long calls — profit rises without limit as the underlying rises",
          }
        : { value: Number(best.v.toFixed(2)), unbounded: false, at: best.s },
    max_loss:
      slopeUp < -1e-9
        ? {
            value: null,
            unbounded: true,
            at: null,
            note: "net short calls — loss grows without limit as the underlying rises",
          }
        : { value: Number(worst.v.toFixed(2)), unbounded: false, at: worst.s },
    current: { pnl_if_expired_now: Number(payoffAt(legs, spot).toFixed(2)), pnl_today: null },
    pop: null,
    dte_days: Math.max(
      0,
      Math.round((new Date(legs[0].expiry).getTime() - Date.now()) / 86_400_000)
    ),
    iv_used: null,
    legs_missing_iv: [],
  };
}

/**
 * Expiry payoff immediately, then the modelled lines when the backend answers.
 *
 * `spot` may be null while the underlying is still being typed; the hook asks
 * the backend for it and reuses the answer for the local curve, so the chart
 * appears as soon as there is a price to centre it on.
 */
export function usePayoff(legs: PayoffLeg[] | null, { debounceMs = 400 } = {}) {
  const [remote, setRemote] = useState<PayoffResult | null>(null);
  const [spot, setSpot] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The serialized legs are the ONLY dependency. Callers build the array inline,
  // so its identity changes on every render — depending on the array itself
  // re-ran this effect each render, which cleared the timer and aborted the
  // in-flight request every time. The symptom was hundreds of ERR_ABORTED
  // requests and a chart that never drew.
  const key = legs?.length ? JSON.stringify(legs) : "";

  useEffect(() => {
    if (!key) {
      setRemote(null);
      return;
    }
    const payloadLegs: PayoffLeg[] = JSON.parse(key);
    if (timer.current) clearTimeout(timer.current);
    const controller = new AbortController();
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/options/payoff", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ legs: payloadLegs }),
          signal: controller.signal,
        });
        const d = await r.json();
        if (r.ok && !d?.error) {
          setRemote(d);
          if (d.spot > 0) setSpot(d.spot);
        } else {
          // Keep whatever spot we already know so the local curve survives a
          // failed lookup instead of blanking the chart.
          setRemote(null);
        }
      } catch {
        /* aborted or offline — the local expiry curve still stands */
      } finally {
        setLoading(false);
      }
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      controller.abort();
    };
  }, [key, debounceMs]);

  // Redrawn from the serialized legs for the same reason as the effect above.
  // Once `spot` is known this is instant on every subsequent keystroke — the
  // first draw still waits for the backend, because the price to centre the
  // chart on has to come from somewhere.
  const local = useMemo(
    () => (key && spot ? localPayoff(JSON.parse(key) as PayoffLeg[], spot) : null),
    [key, spot]
  );

  // Prefer the backend's answer once it lands: it carries the T+0 line and POP,
  // and its expiry line is the same arithmetic.
  return { payoff: remote ?? local, loading, spot };
}
