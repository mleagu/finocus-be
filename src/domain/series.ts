import type { SeriesPoint } from '../types';

/**
 * Small time-series helpers shared by the stats engine.
 *
 * These used to live in `services/returns.ts` alongside the legacy multi-asset
 * timeframe machinery. That module went away with the "Other markets" screens;
 * only these two survived, so they moved here rather than leaving a service
 * module standing for two pure functions.
 */

/** Simple percentage change, e.g. pctChange(100, 110) === 10. */
export function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

/** Ensure a series is sorted ascending by timestamp (does not mutate input). */
export function sortSeries(series: SeriesPoint[]): SeriesPoint[] {
  return [...series].sort((a, b) => a.t - b.t);
}

/**
 * Latest value at or before `targetMs`. Assumes `series` is sorted ascending.
 * Returns undefined if every point is after `targetMs`.
 */
export function valueAsOf(series: SeriesPoint[], targetMs: number): number | undefined {
  let result: number | undefined;
  for (const point of series) {
    if (point.t <= targetMs) result = point.v;
    else break;
  }
  return result;
}

/** UTC start-of-year for the year containing `nowMs`. */
export function startOfYearMs(nowMs: number): number {
  return Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1);
}
