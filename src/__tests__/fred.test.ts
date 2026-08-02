import {
  alignedLatest,
  alignedSeries,
  deriveValuation,
  percentileRank,
  fredUrl,
  latestPoint,
  parseFredDate,
  parseFredObservations,
  realReturnPct,
  yearOverYearPct,
} from '../sources/fred';

const q = (year: number, month: number, v: number) => ({ t: Date.UTC(year, month - 1, 1), v });

describe('parseFredDate', () => {
  it('parses YYYY-MM-DD as UTC midnight', () => {
    expect(parseFredDate('2026-07-01')).toBe(Date.UTC(2026, 6, 1));
  });

  it('returns NaN for malformed input', () => {
    expect(Number.isNaN(parseFredDate('07/01/2026'))).toBe(true);
    expect(Number.isNaN(parseFredDate(''))).toBe(true);
  });
});

describe('parseFredObservations', () => {
  it('maps observations and drops FRED’s "." placeholders', () => {
    const points = parseFredObservations({
      observations: [
        { date: '2026-07-01', value: '4.48' },
        { date: '2026-07-02', value: '4.49' },
        { date: '2026-07-03', value: '.' }, // market holiday
      ],
    });
    expect(points).toEqual([
      { t: Date.UTC(2026, 6, 1), v: 4.48 },
      { t: Date.UTC(2026, 6, 2), v: 4.49 },
    ]);
  });

  it('sorts ascending and tolerates empty/missing payloads', () => {
    const points = parseFredObservations({
      observations: [
        { date: '2026-07-05', value: '2' },
        { date: '2026-07-01', value: '1' },
      ],
    });
    expect(points.map((p) => p.v)).toEqual([1, 2]);
    expect(parseFredObservations({})).toEqual([]);
    expect(parseFredObservations({ observations: [] })).toEqual([]);
  });

  it('drops non-numeric values rather than coercing them to 0', () => {
    expect(parseFredObservations({ observations: [{ date: '2026-07-01', value: 'n/a' }] })).toEqual(
      [],
    );
  });
});

describe('latestPoint', () => {
  it('returns the last point, or undefined when empty', () => {
    expect(latestPoint([q(2026, 1, 5), q(2026, 4, 7)])?.v).toBe(7);
    expect(latestPoint([])).toBeUndefined();
  });
});

describe('alignedLatest', () => {
  it('picks the newest quarter present in both series', () => {
    // GDP publishes a quarter ahead of the Z.1 tables — Q2 must be ignored.
    const equities = [q(2025, 10, 68000000), q(2026, 1, 69511628)];
    const gdp = [q(2025, 10, 32000), q(2026, 1, 32200), q(2026, 4, 32475.21)];
    expect(alignedLatest(equities, gdp)).toEqual({
      t: Date.UTC(2026, 0, 1),
      a: 69511628,
      b: 32200,
    });
  });

  it('returns undefined when the series never overlap', () => {
    expect(alignedLatest([q(2026, 1, 1)], [q(2025, 1, 1)])).toBeUndefined();
  });
});

describe('alignedSeries', () => {
  it('returns every common date, ascending, dropping the rest', () => {
    const a = [q(2025, 10, 1), q(2026, 1, 2), q(2026, 4, 3)];
    const b = [q(2025, 10, 10), q(2026, 4, 30)];
    expect(alignedSeries(a, b)).toEqual([
      { t: Date.UTC(2025, 9, 1), a: 1, b: 10 },
      { t: Date.UTC(2026, 3, 1), a: 3, b: 30 },
    ]);
  });

  it('is empty when nothing overlaps', () => {
    expect(alignedSeries([q(2026, 1, 1)], [q(2025, 1, 1)])).toEqual([]);
  });
});

describe('percentileRank', () => {
  it('ranks a value against its own distribution', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileRank(values, 10)).toBe(100);
    expect(percentileRank(values, 5)).toBe(50);
    expect(percentileRank(values, 1)).toBe(10);
  });

  it('counts values at or below, so a new extreme reads as 100', () => {
    expect(percentileRank([1, 2, 3], 99)).toBe(100);
    expect(percentileRank([1, 2, 3], 0)).toBe(0);
  });

  it('ignores non-finite entries and empty input', () => {
    expect(percentileRank([1, NaN, 3], 3)).toBe(100);
    expect(percentileRank([], 1)).toBeUndefined();
    expect(percentileRank([1, 2], NaN)).toBeUndefined();
  });
});

describe('yearOverYearPct', () => {
  it('compares the latest month against the same month a year earlier', () => {
    const cpi = [q(2025, 6, 320), q(2025, 12, 328), q(2026, 6, 332.8)];
    expect(yearOverYearPct(cpi)).toBeCloseTo(4, 10);
  });

  it('returns undefined without a matching prior-year month', () => {
    expect(yearOverYearPct([q(2026, 6, 332.8)])).toBeUndefined();
    expect(yearOverYearPct([])).toBeUndefined();
  });
});

describe('realReturnPct', () => {
  it('uses the Fisher relation, not naive subtraction', () => {
    // (1.10 / 1.04) - 1 = 5.769…%, not 6%.
    expect(realReturnPct(10, 4)).toBeCloseTo(5.7692, 4);
  });

  it('returns undefined when either input is missing', () => {
    expect(realReturnPct(10, undefined)).toBeUndefined();
    expect(realReturnPct(undefined, 4)).toBeUndefined();
  });
});

describe('deriveValuation', () => {
  // Real values pulled from FRED on 2026-08-01 (Q1 2026).
  const corporateEquities = [q(2026, 1, 69511628)]; // $ millions
  const corporateProfits = [q(2026, 1, 2564.638)]; // $ billions
  const gdp = [q(2026, 1, 32000), q(2026, 4, 32475.21)];

  it('ranks the latest P/E against its own history', () => {
    const v = deriveValuation({
      // Quarter-by-quarter climb, so the newest reading is the most expensive.
      corporateEquities: [q(2025, 4, 40000000), q(2025, 7, 50000000), q(2026, 1, 69511628)],
      corporateProfits: [q(2025, 4, 2500), q(2025, 7, 2500), q(2026, 1, 2564.638)],
      gdp: [],
    });
    expect(v.marketPePercentile).toBe(100);
    expect(v.historySinceT).toBe(Date.UTC(2025, 3, 1));
  });

  it('builds P/E from the matched nonfinancial-corporate pair, converting units', () => {
    const v = deriveValuation({ corporateEquities, corporateProfits, gdp, treasury10YPct: 4.68 });
    // 69,511.628B / 2,564.638B
    expect(v.marketPe).toBeCloseTo(27.1041, 3);
    expect(v.earningsYieldPct).toBeCloseTo(3.6895, 4);
    expect(v.equityRiskPremiumPct).toBeCloseTo(3.6895 - 4.68, 4);
    expect(v.asOf).toBe(Date.UTC(2026, 0, 1));
  });

  it('computes the Buffett indicator against the common quarter', () => {
    const v = deriveValuation({ corporateEquities, corporateProfits, gdp });
    expect(v.buffettIndicatorPct).toBeCloseTo((69511.628 / 32000) * 100, 3);
  });

  it('omits the equity risk premium when the 10Y yield is unavailable', () => {
    const v = deriveValuation({ corporateEquities, corporateProfits, gdp });
    expect(v.equityRiskPremiumPct).toBeUndefined();
    expect(v.marketPe).toBeDefined();
  });

  it('degrades to an empty snapshot when series are missing', () => {
    expect(deriveValuation({ corporateEquities: [], corporateProfits: [], gdp: [] })).toEqual({});
  });

  it('guards against a non-positive earnings denominator', () => {
    const v = deriveValuation({
      corporateEquities,
      corporateProfits: [q(2026, 1, 0)],
      gdp: [],
    });
    expect(v.marketPe).toBeUndefined();
  });
});

describe('fredUrl', () => {
  // The key is a parameter here, not a module constant: on the Worker it comes
  // from a secret, so nothing in this repo can hold one.
  const KEY = 'test-key';

  it('requests ascending JSON observations for the series', () => {
    const url = fredUrl('DGS10', KEY);
    expect(url).toContain('/series/observations?');
    expect(url).toContain('series_id=DGS10');
    expect(url).toContain('file_type=json');
    expect(url).toContain('sort_order=asc');
    expect(url).toContain(`api_key=${KEY}`);
  });

  it('adds observation_start as a plain date when given a lower bound', () => {
    expect(fredUrl('DGS10', KEY, Date.UTC(2020, 0, 15))).toContain(
      'observation_start=2020-01-15',
    );
  });
});
