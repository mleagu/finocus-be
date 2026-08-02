import type { OhlcvPoint } from '../types';
import {
  atr,
  bollinger,
  cagr,
  computeStats,
  currentStreak,
  ema,
  emaSeries,
  fiftyTwoWeek,
  historicalVar,
  kurtosis,
  maxDrawdown,
  mean,
  median,
  monthlyCloses,
  periodReturn,
  rsi,
  sharpe,
  simpleReturns,
  skewness,
  sma,
  stdev,
} from '../domain/stats';

const DAY = 86_400_000;
const NOW = Date.UTC(2025, 5, 1); // 2025-06-01 UTC

/** Build a daily OHLCV series from a close array, last bar landing on `endMs`. */
function ohlcv(closeArr: number[], endMs = NOW): OhlcvPoint[] {
  const n = closeArr.length;
  return closeArr.map((c, i) => ({
    t: endMs - (n - 1 - i) * DAY,
    o: c,
    h: c,
    l: c,
    c,
    v: 1000,
  }));
}

function series(closeArr: number[], endMs = NOW) {
  return ohlcv(closeArr, endMs).map((p) => ({ t: p.t, v: p.c }));
}

describe('basic moments', () => {
  it('mean / median', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 2, 3])).toBe(2);
  });

  it('sample vs population stdev', () => {
    expect(stdev([2, 4, 6, 8, 10], false)).toBeCloseTo(Math.sqrt(8)); // population
    expect(stdev([2, 4, 6, 8, 10], true)).toBeCloseTo(Math.sqrt(10)); // sample (n-1)
  });

  it('skewness ~0 and excess kurtosis defined for symmetric data', () => {
    const sym = [-2, -1, 0, 1, 2];
    expect(skewness(sym)).toBeCloseTo(0);
    expect(typeof kurtosis(sym)).toBe('number');
  });
});

describe('simpleReturns', () => {
  it('computes period-over-period fractions', () => {
    expect(simpleReturns([100, 110, 99])).toEqual([expect.closeTo(0.1), expect.closeTo(-0.1)]);
  });
});

describe('cagr', () => {
  it('annualizes a doubling over 10 years to ~7.18%', () => {
    expect(cagr(100, 200, 10)).toBeCloseTo(7.177, 2);
  });
  it('is undefined for non-positive inputs', () => {
    expect(cagr(0, 100, 5)).toBeUndefined();
    expect(cagr(100, 200, 0)).toBeUndefined();
  });
});

describe('periodReturn', () => {
  const s = series(Array.from({ length: 400 }, (_, i) => 100 + i)); // 100..499 ending NOW

  it('1W return anchors one week back', () => {
    expect(periodReturn(s, '1W', NOW)).toBeCloseTo(((499 - 492) / 492) * 100);
  });

  it('MAX return spans first→last close', () => {
    expect(periodReturn(s, 'MAX', NOW)).toBeCloseTo(((499 - 100) / 100) * 100);
  });
});

describe('maxDrawdown', () => {
  it('finds the worst peak-to-trough decline', () => {
    const dd = maxDrawdown(series([100, 120, 90, 110]))!;
    expect(dd.drawdownPct).toBeCloseTo(-25); // 120 → 90
  });
});

describe('fiftyTwoWeek', () => {
  it('reports range position of the latest price', () => {
    const r = fiftyTwoWeek(series([10, 20, 30, 40, 50]))!;
    expect(r.high).toBe(50);
    expect(r.low).toBe(10);
    expect(r.pctOfRange).toBeCloseTo(100); // last == high
  });
});

describe('currentStreak', () => {
  it('counts trailing same-direction days', () => {
    expect(currentStreak([0.01, -0.01, 0.02, 0.03])).toEqual({ direction: 'up', length: 2 });
    expect(currentStreak([-0.01, -0.02])).toEqual({ direction: 'down', length: 2 });
  });
});

describe('technicals', () => {
  it('sma over trailing window', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 2)).toBe(4.5);
    expect(sma([1, 2], 5)).toBeUndefined();
  });

  it('ema seeded with SMA', () => {
    expect(emaSeries([1, 2, 3, 4, 5], 2)).toEqual([
      1.5,
      expect.closeTo(2.5),
      expect.closeTo(3.5),
      expect.closeTo(4.5),
    ]);
    expect(ema([1, 2, 3, 4, 5], 2)).toBeCloseTo(4.5);
  });

  it('rsi saturates at extremes', () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)).toBe(100);
    expect(rsi([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14)).toBe(0);
  });

  it('atr with period 1 equals the latest true range', () => {
    const pts: OhlcvPoint[] = [
      { t: 0, o: 9, h: 10, l: 8, c: 9, v: 0 },
      { t: DAY, o: 11, h: 12, l: 9, c: 11, v: 0 },
      { t: 2 * DAY, o: 8, h: 11, l: 7, c: 8, v: 0 },
    ];
    expect(atr(pts, 1)).toBeCloseTo(4); // last TR = max(11-7, |11-11|, |7-11|) = 4
  });

  it('bollinger bands from population stdev', () => {
    const b = bollinger([2, 4, 6, 8, 10], 5, 2)!;
    expect(b.middle).toBeCloseTo(6);
    expect(b.upper).toBeCloseTo(6 + 2 * Math.sqrt(8));
    expect(b.lower).toBeCloseTo(6 - 2 * Math.sqrt(8));
  });
});

describe('historicalVar', () => {
  it('returns the loss at the (1-confidence) percentile as a positive percent', () => {
    const rets = [-0.05, -0.03, -0.01, 0.01, 0.02, 0.04, 0.05, 0.03, -0.02, 0.01];
    expect(historicalVar(rets, 0.95)).toBeCloseTo(5); // worst = -5%
  });
});

describe('sharpe', () => {
  it('is positive for a steadily rising series at zero risk-free', () => {
    const rets = simpleReturns(Array.from({ length: 50 }, (_, i) => 100 * 1.001 ** i));
    expect(sharpe(rets, 0)!).toBeGreaterThan(0);
  });
});

describe('monthlyCloses', () => {
  it('keeps the last close of each calendar month', () => {
    const s = [
      { t: Date.UTC(2024, 0, 5), v: 1 },
      { t: Date.UTC(2024, 0, 25), v: 2 },
      { t: Date.UTC(2024, 1, 3), v: 3 },
    ];
    expect(monthlyCloses(s).map((p) => p.v)).toEqual([2, 3]);
  });
});

describe('computeStats integration', () => {
  const points = ohlcv(Array.from({ length: 300 }, (_, i) => 100 * 1.002 ** i));
  const stats = computeStats(points, NOW, 4)!;

  it('produces a populated summary', () => {
    expect(stats.price).toBeCloseTo(100 * 1.002 ** 299);
    expect(stats.returns.MAX).toBeGreaterThan(0);
    expect(stats.technicals.sma20).toBeDefined();
    expect(stats.technicals.goldenCross).toBe(true); // steadily rising → 50 > 200
    expect(stats.risk.annualizedVolPct).toBeGreaterThan(0);
    expect(stats.distribution.seasonality).toHaveLength(12);
    expect(stats.performance.upDayPct).toBe(100); // every day up
  });

  it('returns undefined for too-short input', () => {
    expect(computeStats(ohlcv([100]), NOW)).toBeUndefined();
  });
});
