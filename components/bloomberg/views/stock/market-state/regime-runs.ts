/**
 * Collapse a per-bar regime label array into contiguous runs.
 *
 * Lives apart from the chart component for two reasons: it is the only part of
 * the regime chart with logic worth testing, and node's type stripping cannot
 * load a `.tsx` file, so a pure helper inside the component would be
 * untestable.
 *
 * The chart draws one shaded band per run rather than per bar — 500 bars would
 * mean 500 SVG rects with visible seams at every boundary, and the run form is
 * also what makes a regime's DURATION legible, which is half of what the
 * shading is for.
 */

export interface Run {
  state: number;
  /** First bar index of the run. */
  from: number;
  /** Last bar index, inclusive. */
  to: number;
}

export function toRuns(states: number[]): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < states.length; i++) {
    const last = runs[runs.length - 1];
    // Only EXTEND when the previous run is adjacent and the same state — a
    // state that comes back after an excursion must start a new run, or the
    // band would be drawn straight over the state in between.
    if (last && last.state === states[i]) last.to = i;
    else runs.push({ state: states[i], from: i, to: i });
  }
  return runs;
}
