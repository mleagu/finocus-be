import { parseYahooChart, yahooUrl, type YahooChartResponse } from '../sources/yahoo';

function response(overrides: Partial<YahooChartResponse['chart']> = {}): YahooChartResponse {
  return {
    chart: {
      result: [
        {
          timestamp: [1704153600, 1704240000, 1704326400], // 2024-01-02..04 UTC
          indicators: {
            quote: [
              {
                open: [4745.2, 4725.07, 4697.42],
                high: [4765.47, 4729.29, 4726.78],
                low: [4730.35, 4699.71, 4687.53],
                close: [4742.83, 4704.81, 4688.68],
                volume: [3443760000, 3688780000, 3611290000],
              },
            ],
          },
        },
      ],
      ...overrides,
    },
  };
}

describe('parseYahooChart', () => {
  it('maps timestamps (s→ms) and OHLCV', () => {
    const points = parseYahooChart(response());
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({
      t: 1704153600 * 1000,
      o: 4745.2,
      h: 4765.47,
      l: 4730.35,
      c: 4742.83,
      v: 3443760000,
    });
  });

  it('drops days with a null close and falls back per-field', () => {
    const r = response();
    r.chart.result![0].indicators.quote![0].close = [4742.83, null, 4688.68];
    r.chart.result![0].indicators.quote![0].open = [4745.2, 4725.07, null];
    r.chart.result![0].indicators.quote![0].volume = [3443760000, 0, null];
    const points = parseYahooChart(r);
    expect(points).toHaveLength(2); // middle (null close) dropped
    expect(points[1].o).toBe(4688.68); // null open → falls back to close
    expect(points[1].v).toBe(0); // null volume → 0
  });

  it('returns [] for an empty / error response', () => {
    expect(parseYahooChart({ chart: { error: 'Not Found' } })).toEqual([]);
    expect(parseYahooChart({ chart: { result: [] } })).toEqual([]);
  });
});

describe('yahooUrl', () => {
  it('builds a v8 chart URL with epoch-second bounds', () => {
    const url = yahooUrl('^GSPC', Date.UTC(2004, 5, 1), Date.UTC(2024, 5, 1));
    expect(url).toContain('/v8/finance/chart/%5EGSPC?');
    expect(url).toContain('interval=1d');
    expect(url).toContain(`period1=${Math.floor(Date.UTC(2004, 5, 1) / 1000)}`);
    expect(url).toContain(`period2=${Math.floor(Date.UTC(2024, 5, 1) / 1000)}`);
  });
});
