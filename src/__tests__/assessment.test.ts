import type { MacroSnapshot } from '../sources/fred';
import type { OhlcvPoint } from '../types';
import {
  blendedValuationPercentile,
  buildAssessment,
  ordinal,
  verdictFrom,
} from '../domain/assessment';
import { computeStats } from '../domain/stats';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1);

function ohlcv(closeArr: number[]): OhlcvPoint[] {
  const n = closeArr.length;
  return closeArr.map((c, i) => ({ t: NOW - (n - 1 - i) * DAY, o: c, h: c, l: c, c, v: 1000 }));
}

/** Steadily rising 300-day series → uptrend, near its high. */
const rising = computeStats(ohlcv(Array.from({ length: 300 }, (_, i) => 100 * 1.002 ** i)), NOW)!;

/** Rises then falls 30% → below the 200-day, deep in a drawdown. */
const crashed = computeStats(
  ohlcv([
    ...Array.from({ length: 200 }, (_, i) => 100 * 1.004 ** i),
    ...Array.from({ length: 100 }, (_, i) => 100 * 1.004 ** 199 * 0.9965 ** i),
  ]),
  NOW,
)!;

const expensiveMacro: MacroSnapshot = {
  treasury10YPct: 4.68,
  spread10Y3MPct: -0.4,
  vix: 34,
  vixPercentile: 95,
  cpiYoYPct: 4.6,
  riskFreeAnnualPct: 3.82,
  valuation: {
    marketPe: 27.1,
    earningsYieldPct: 3.69,
    equityRiskPremiumPct: -0.99,
    buffettIndicatorPct: 218,
    marketPePercentile: 94,
    buffettPercentile: 97,
    historySinceT: Date.UTC(1947, 0, 1),
    asOf: Date.UTC(2026, 0, 1),
  },
};

const cheapMacro: MacroSnapshot = {
  treasury10YPct: 3,
  spread10Y3MPct: 1.8,
  vix: 12,
  vixPercentile: 10,
  cpiYoYPct: 2,
  valuation: {
    marketPe: 11,
    earningsYieldPct: 9.09,
    equityRiskPremiumPct: 6.09,
    buffettIndicatorPct: 60,
    marketPePercentile: 8,
    buffettPercentile: 12,
    historySinceT: Date.UTC(1947, 0, 1),
    asOf: Date.UTC(2026, 0, 1),
  },
};

describe('ordinal', () => {
  it('formats ordinary suffixes', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(94)).toBe('94th');
  });

  it('handles the 11/12/13 exceptions', () => {
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(111)).toBe('111th');
  });
});

describe('verdictFrom', () => {
  it('maps percentiles to verdicts at the documented cut points', () => {
    expect(verdictFrom(95)).toBe('stretched');
    expect(verdictFrom(90)).toBe('stretched');
    expect(verdictFrom(75)).toBe('elevated');
    expect(verdictFrom(50)).toBe('fairly valued');
    expect(verdictFrom(25)).toBe('undervalued');
    expect(verdictFrom(undefined)).toBe('unknown');
  });
});

describe('blendedValuationPercentile', () => {
  it('averages the available valuation percentiles', () => {
    expect(blendedValuationPercentile(expensiveMacro)).toBeCloseTo(95.5, 5);
  });

  it('is undefined without any valuation data', () => {
    expect(blendedValuationPercentile(undefined)).toBeUndefined();
    expect(blendedValuationPercentile({ valuation: {} })).toBeUndefined();
  });
});

describe('buildAssessment — expensive, risky market', () => {
  const a = buildAssessment(rising, expensiveMacro);
  const find = (group: 'valuation' | 'risk' | 'trend', label: string) =>
    a[group].find((s) => s.label === label);

  it('calls valuation stretched and says so in the headline', () => {
    expect(a.verdict).toBe('stretched');
    expect(a.headline).toMatch(/stretched/);
    expect(a.headline).toMatch(/96th percentile/);
  });

  it('warns on a negative equity risk premium', () => {
    const erp = find('valuation', 'Equity risk premium');
    expect(erp?.level).toBe('warning');
    expect(erp?.detail).toMatch(/below the 10Y Treasury/);
  });

  it('warns on an inverted curve and names the spread used', () => {
    const curve = find('risk', 'Yield curve');
    expect(curve?.level).toBe('warning');
    expect(curve?.value).toMatch(/10Y − 3M/);
    expect(curve?.detail).toMatch(/Inverted/);
  });

  it('warns on a 95th-percentile VIX and above-target inflation', () => {
    expect(find('risk', 'VIX')?.level).toBe('warning');
    expect(find('risk', 'Inflation')?.level).toBe('warning');
  });

  it('still reports the uptrend as intact', () => {
    expect(find('trend', 'Price vs 200-day')?.level).toBe('good');
    expect(find('trend', 'Trend structure')?.value).toBe('Golden cross');
  });

  it('enumerates the warning signals in the headline', () => {
    expect(a.headline).toMatch(/warning signals:/);
    expect(a.headline).toMatch(/yield curve/);
  });

  it('flags the P/E as an economy-wide proxy, not the index P/E', () => {
    expect(find('valuation', 'Market P/E')?.detail).toMatch(/not the index's own P\/E/);
    expect(find('valuation', 'Market P/E')?.detail).toMatch(/since 1947/);
  });
});

describe('buildAssessment — cheap, calm market', () => {
  const a = buildAssessment(rising, cheapMacro);

  it('calls valuation low with no warnings', () => {
    expect(a.verdict).toBe('undervalued');
    expect([...a.valuation, ...a.risk, ...a.trend].some((s) => s.level === 'warning')).toBe(false);
    expect(a.headline).toMatch(/No warning signals/);
  });

  it('rates a healthy risk premium and a positively sloped curve as good', () => {
    expect(a.valuation.find((s) => s.label === 'Equity risk premium')?.level).toBe('good');
    expect(a.risk.find((s) => s.label === 'Yield curve')?.level).toBe('good');
  });
});

describe('buildAssessment — drawdown handling', () => {
  it('flags a >20% fall as bear-market territory and a broken trend', () => {
    const a = buildAssessment(crashed, cheapMacro);
    const dd = a.risk.find((s) => s.label === 'Drawdown from high');
    expect(dd?.level).toBe('warning');
    expect(dd?.detail).toMatch(/Bear-market territory/);
    expect(a.trend.find((s) => s.label === 'Price vs 200-day')?.level).toBe('caution');
  });

  it('treats a market near its high as neutral, not good', () => {
    const a = buildAssessment(rising, cheapMacro);
    expect(a.risk.find((s) => s.label === 'Drawdown from high')?.level).toBe('neutral');
  });
});

describe('buildAssessment — without FRED data', () => {
  const a = buildAssessment(rising, undefined);

  it('degrades to an unknown verdict rather than inventing one', () => {
    expect(a.verdict).toBe('unknown');
    expect(a.valuationPercentile).toBeUndefined();
    expect(a.headline).toMatch(/Valuation is unavailable/);
    expect(a.valuation[0].value).toBe('N/A');
  });

  it('still produces trend signals from price data alone', () => {
    expect(a.trend.length).toBeGreaterThan(0);
    expect(a.risk.some((s) => s.label === 'Drawdown from high')).toBe(true);
  });
});
