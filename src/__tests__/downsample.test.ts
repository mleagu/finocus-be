import { describe, expect, it } from 'vitest';
import { allTimeHigh, allTimeLow, downsample, sliceByWindow } from '../domain/stats';
import type { SeriesPoint } from '../types';

/**
 * These pin the two failures the old stride sampler had. Neither threw, and
 * both were visible in the app: extremes quoted by the stats were missing from
 * the chart, and switching windows redrew the same period with a different
 * shape.
 */

const DAY = 86_400_000;

/** Deterministic series with one unmistakable spike and one trough. */
function series(n: number, spikeAt?: number, troughAt?: number): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => {
    let v = 100 + Math.sin(i / 7) * 5;
    if (i === spikeAt) v = 9999;
    if (i === troughAt) v = -9999;
    return { t: i * DAY, v };
  });
}

describe('downsample', () => {
  it('returns short series untouched', () => {
    const s = series(50);
    expect(downsample(s, 300)).toEqual(s);
  });

  it('stays within the point budget', () => {
    for (const n of [301, 753, 1256, 2515, 5030]) {
      expect(downsample(series(n), 300).length).toBeLessThanOrEqual(300);
    }
  });

  it('keeps the global maximum, however deeply it thins', () => {
    // The old sampler kept every 17th bar at this size, so a one-day spike had
    // a ~94% chance of being dropped entirely.
    const s = series(5030, 2500);
    const out = downsample(s, 300);
    expect(out.some((p) => p.v === 9999)).toBe(true);
  });

  it('keeps the global minimum', () => {
    const s = series(5030, undefined, 1234);
    expect(downsample(s, 300).some((p) => p.v === -9999)).toBe(true);
  });

  it('agrees with the stats printed beside the chart', () => {
    // The real defect: allTimeHigh runs over the FULL series, so a chart that
    // dropped the peak contradicted the number next to it.
    const s = series(5030, 3000, 900);
    const out = downsample(s, 300);
    expect(allTimeHigh(out)?.value).toBe(allTimeHigh(s)?.value);
    expect(allTimeLow(out)?.value).toBe(allTimeLow(s)?.value);
  });

  it('preserves the first and last bars exactly', () => {
    const s = series(5030);
    const out = downsample(s, 300);
    expect(out[0]).toEqual(s[0]);
    expect(out[out.length - 1]).toEqual(s[s.length - 1]);
  });

  it('stays in chronological order', () => {
    const out = downsample(series(5030, 2000, 2001), 300);
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
  });

  it('emits no duplicate timestamps', () => {
    const out = downsample(series(5030), 300);
    expect(new Set(out.map((p) => p.t)).size).toBe(out.length);
  });

  it('shows the same peak in every window that contains it', () => {
    // The inconsistency report: each window sliced to a different length, so the
    // stride differed and the same day survived in one window but not another.
    const now = 5030 * DAY;
    const full = series(5030, 4800);
    const peak = full[4800].v;
    for (const w of ['1Y', '3Y', '5Y', '10Y', 'MAX'] as const) {
      const sliced = sliceByWindow(full, w, now);
      if (!sliced.some((p) => p.v === peak)) continue; // peak outside this window
      expect(downsample(sliced, 300).some((p) => p.v === peak)).toBe(true);
    }
  });

  it('handles a flat series without collapsing it', () => {
    const flat = Array.from({ length: 1000 }, (_, i) => ({ t: i * DAY, v: 42 }));
    const out = downsample(flat, 300);
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((p) => p.v === 42)).toBe(true);
    expect(out[out.length - 1].t).toBe(flat[flat.length - 1].t);
  });
});
