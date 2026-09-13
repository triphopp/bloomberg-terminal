"use client";

import { fitBollingerSharpe } from "./bollinger-fit";
import type { ChartColors, OhlcvBar } from "./types";

function dateLabel(time: string | number): string {
  return typeof time === "number"
    ? new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ")
    : time;
}

export function BollingerFitSummary({
  data,
  costBps,
  colors,
}: {
  data: readonly OhlcvBar[];
  costBps: number;
  colors: ChartColors;
}) {
  const fit = fitBollingerSharpe(data, costBps);
  const best = fit.best;
  return (
    <div
      className="text-[9px] font-mono flex flex-col gap-1.5 border-t pt-2 max-w-[330px]"
      style={{ borderColor: colors.border, color: colors.textSecondary }}
    >
      <div style={{ color: colors.text }}>BREAKOUT · LONG / CASH</div>
      <div>%B = (Close − Lower) / (Upper − Lower)</div>
      <div>Buy %B &gt; 1 · Exit %B ≤ 0.5 · next open</div>
      <div>GRID n: 10–100 / 5 bars · k: 1–3.5 / 0.25</div>
      {best && fit.holdout ? (
        <>
          <div className="font-bold" style={{ color: colors.accent ?? colors.positive }}>
            BEST n={best.period} bars · k={best.stdDev}σ
          </div>
          <table className="w-full text-right">
            <thead>
              <tr>
                <th className="text-left">PER BAR</th>
                <th>TRAIN</th>
                <th>HOLDOUT</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="text-left">Sharpe</td>
                <td>{best.train.sharpe?.toFixed(4)}</td>
                <td>{fit.holdout.sharpe?.toFixed(4) ?? "N/A"}</td>
              </tr>
              <tr>
                <td className="text-left">Net return</td>
                <td>{(best.train.totalReturn * 100).toFixed(2)}%</td>
                <td>{(fit.holdout.totalReturn * 100).toFixed(2)}%</td>
              </tr>
              <tr>
                <td className="text-left">Closed trades</td>
                <td>{best.train.trades}</td>
                <td>{fit.holdout.trades}</td>
              </tr>
              <tr>
                <td className="text-left">Bars</td>
                <td>{best.train.bars}</td>
                <td>{fit.holdout.bars}</td>
              </tr>
            </tbody>
          </table>
          <div>
            {fit.eligible}/{fit.candidates} eligible · minimum 3 training trades
          </div>
          <div>
            Train: {dateLabel(data[fit.trainStart].time)} → {dateLabel(data[fit.split - 1].time)}
          </div>
          <div>
            Holdout: {dateLabel(data[fit.split].time)} → {dateLabel(data[fit.end - 1].time)}
          </div>
          {fit.holdout.trades < 3 && (
            <div style={{ color: colors.accent }}>
              Holdout has fewer than 3 trades; evidence is limited.
            </div>
          )}
        </>
      ) : (
        <output style={{ color: colors.accent }}>
          FIT UNAVAILABLE · {fit.reason} Manual bands remain active.
        </output>
      )}
      <div>
        70% train / 30% holdout after 100 warmup bars. Newest bar excluded. Holdout never selects
        n/k.
      </div>
      <div>
        Sharpe = mean(net returns) / sample SD, per bar; risk-free = 0. Cost {costBps} bps each
        side. Price returns; no dividend cashflows. Close open trades at each window end.
      </div>
      <div>
        Refits when loaded history changes. Fitted historical bands redraw; these are not
        walk-forward results.
      </div>
      <div>
        Fit applies to this chart history. Quick alerts use fixed parameters; fitted indicators are
        omitted from “From chart”.
      </div>
    </div>
  );
}
