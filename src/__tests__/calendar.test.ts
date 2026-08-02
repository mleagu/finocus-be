import { buildCalendar, isoDate, weekWindow } from '../domain/calendar';
import { formatValue, parseEconomicEvents } from '../sources/economicCalendar';
import {
  countEarnings,
  mergeShareClasses,
  parseEarnings,
  parseMoney,
  parseWhen,
} from '../sources/earnings';

const NOW = Date.UTC(2026, 7, 2); // 2026-08-02

describe('weekWindow', () => {
  it('covers today plus the next seven days, inclusive', () => {
    const { from, to, dates } = weekWindow(NOW);
    expect(from).toBe('2026-08-02');
    expect(to).toBe('2026-08-09');
    expect(dates).toHaveLength(8);
  });

  it('rolls over month boundaries', () => {
    expect(isoDate(Date.UTC(2026, 7, 30), 5)).toBe('2026-09-04');
  });
});

describe('formatValue', () => {
  it('applies scale and unit', () => {
    expect(formatValue(7.25, null, 'M')).toBe('7.25M');
    expect(formatValue(4.3, '%', null)).toBe('4.3%');
    expect(formatValue(91, null, 'K')).toBe('91K');
    expect(formatValue(53.3, null, null)).toBe('53.3');
  });

  it('keeps zero, which is a real reading', () => {
    // `if (!value)` would drop "0%" inflation — a genuine and notable print.
    expect(formatValue(0, '%', null)).toBe('0%');
  });

  it('puts currency symbols in front of the number', () => {
    // Concatenating scale then unit gave "-0.79B$" for a trade balance.
    expect(formatValue(-0.79, '$', 'B')).toBe('-$0.79B');
    expect(formatValue(1.2, 'C$', 'B')).toBe('C$1.2B');
    expect(formatValue(3.4, '€', 'B')).toBe('€3.4B');
  });

  it('keeps the minus sign outside the currency symbol', () => {
    expect(formatValue(-2.5, '€', 'B')).not.toBe('€-2.5B');
  });

  it('leaves percent as a suffix', () => {
    expect(formatValue(-0.4, '%', null)).toBe('-0.4%');
  });

  it('returns undefined for absent values', () => {
    expect(formatValue(null)).toBeUndefined();
    expect(formatValue(undefined)).toBeUndefined();
    expect(formatValue(Number.NaN)).toBeUndefined();
  });
});

describe('parseEconomicEvents', () => {
  const FROM = Date.parse('2026-08-02T00:00:00.000Z');
  const TO = Date.parse('2026-08-09T23:59:59.999Z');

  const json = {
    status: 'ok',
    result: [
      { id: '1', title: 'Non Farm Payrolls', country: 'US', date: '2026-08-07T12:30:00.000Z', importance: 1, forecast: 91, previous: 57, scale: 'K' },
      { id: '2', title: 'Inflation Rate YoY', country: 'GB', date: '2026-08-05T06:00:00.000Z', importance: 0, previous: 3.5, unit: '%' },
      { id: '3', title: '4-Week Bill Auction', country: 'US', date: '2026-08-05T16:30:00.000Z', importance: -1 },
      { id: '4', title: 'Out Of Window', country: 'US', date: '2026-09-01T12:30:00.000Z', importance: 1 },
    ],
  };

  it('drops low importance', () => {
    // -1 is ~70% of the feed: bill auctions, balance-sheet lines, regional
    // Fed speeches. Keeping it buries the handful that move an index.
    const names = parseEconomicEvents(json, FROM, TO).map((e) => e.name);
    expect(names).not.toContain('4-Week Bill Auction');
  });

  it('drops events outside the window', () => {
    const names = parseEconomicEvents(json, FROM, TO).map((e) => e.name);
    expect(names).not.toContain('Out Of Window');
  });

  it('maps rank to importance', () => {
    const events = parseEconomicEvents(json, FROM, TO);
    expect(events.find((e) => e.name === 'Non Farm Payrolls')!.importance).toBe('high');
    expect(events.find((e) => e.name === 'Inflation Rate YoY')!.importance).toBe('medium');
  });

  it('keeps a UTC instant rather than a wall-clock time', () => {
    // This is what makes client-local rendering possible at all.
    expect(parseEconomicEvents(json, FROM, TO)[1].at).toBe('2026-08-07T12:30:00.000Z');
  });

  it('carries country and formatted forecast/previous', () => {
    const nfp = parseEconomicEvents(json, FROM, TO).find((e) => e.name === 'Non Farm Payrolls')!;
    expect(nfp.country).toBe('US');
    expect(nfp.forecast).toBe('91K');
    expect(nfp.previous).toBe('57K');
  });

  it('sorts chronologically', () => {
    expect(parseEconomicEvents(json, FROM, TO).map((e) => e.id)).toEqual(['2', '1']);
  });

  it('uses the feed id, so same-name events on one day stay distinct', () => {
    // "Final Manufacturing PMI" lands the same day for three countries in a
    // typical week. A date+name key collides and React silently drops rows —
    // the same defect that already hit the consensus screen once.
    const pmi = {
      result: [
        { id: '10', title: 'Final Manufacturing PMI', country: 'DE', date: '2026-08-03T07:55:00.000Z', importance: 0 },
        { id: '11', title: 'Final Manufacturing PMI', country: 'EU', date: '2026-08-03T08:00:00.000Z', importance: 0 },
        { id: '12', title: 'Final Manufacturing PMI', country: 'GB', date: '2026-08-03T08:30:00.000Z', importance: 0 },
      ],
    };
    const ids = parseEconomicEvents(pmi, FROM, TO).map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('survives malformed input', () => {
    expect(parseEconomicEvents({}, FROM, TO)).toEqual([]);
    expect(parseEconomicEvents(null, FROM, TO)).toEqual([]);
    expect(parseEconomicEvents({ result: [{ id: '1' }] }, FROM, TO)).toEqual([]);
  });
});

describe('parseMoney', () => {
  it('reads accounting parentheses as negative', () => {
    // A third of a typical day's rows are negative and written this way;
    // ignoring the parentheses turns losses into profits on screen.
    expect(parseMoney('($1.93)')).toBe(-1.93);
    expect(parseMoney('($0.05)')).toBe(-0.05);
  });

  it('reads positive amounts and strips separators', () => {
    expect(parseMoney('$6.71')).toBe(6.71);
    expect(parseMoney('$1,087,683,071,688')).toBe(1_087_683_071_688);
  });

  it('returns undefined for blanks and junk', () => {
    expect(parseMoney('')).toBeUndefined();
    expect(parseMoney(undefined)).toBeUndefined();
    expect(parseMoney('N/A')).toBeUndefined();
  });
});

describe('parseWhen', () => {
  it('maps Nasdaq session codes', () => {
    expect(parseWhen('time-pre-market')).toBe('pre');
    expect(parseWhen('time-after-hours')).toBe('post');
    expect(parseWhen('time-not-supplied')).toBeNull();
    expect(parseWhen(undefined)).toBeNull();
  });
});

describe('mergeShareClasses', () => {
  const berkshire = [
    { symbol: 'BRK.A', name: 'Berkshire Hathaway Inc.', when: null, marketCap: 1.1e12 },
    { symbol: 'BRK.B', name: 'Berkshire Hathaway Inc.', when: null, marketCap: 1.1e12, epsForecast: 5.24 },
  ];

  it('collapses share classes into one row', () => {
    // The company reports once; two rows is wrong and burns two ranked slots.
    expect(mergeShareClasses(berkshire)).toHaveLength(1);
  });

  it('keeps the class with analyst coverage', () => {
    // BRK.B carries the estimate, so it is the one people track.
    const [row] = mergeShareClasses(berkshire);
    expect(row.symbol).toBe('BRK.B');
    expect(row.alsoTradesAs).toEqual(['BRK.A']);
  });

  it('breaks ties on estimate count, then symbol', () => {
    const [row] = mergeShareClasses([
      { symbol: 'PBR.A', name: 'Petrobras', when: null, epsForecast: 1.3, estimateCount: 2 },
      { symbol: 'PBR', name: 'Petrobras', when: null, epsForecast: 1.3, estimateCount: 9 },
    ]);
    expect(row.symbol).toBe('PBR');
  });

  it('is symbol-format agnostic, not a dotted-suffix rule', () => {
    // Grouping is by company name, so it catches classes with no dot at all.
    // Measured over a real week of Nasdaq data this merged 15 pairs spanning
    // both conventions: BRK.A/BRK.B, PBR/PBR.A, TAP/TAP.A, GTN/GTN.A but also
    // NWS/NWSA, FOX/FOXA, CENT/CENTA, UA/UAA, KELYA/KELYB. A rule keyed on the
    // symbol string would miss every example in that second group.
    const [fox] = mergeShareClasses([
      { symbol: 'FOXA', name: 'Fox Corporation', when: null, epsForecast: 1.1 },
      { symbol: 'FOX', name: 'Fox Corporation', when: null },
    ]);
    expect(fox.symbol).toBe('FOXA');
    expect(fox.alsoTradesAs).toEqual(['FOX']);
  });

  it('never merges different companies with lookalike symbols', () => {
    // SM/SMA, ACA/ACB and LB/LAB all look like share classes and are not.
    // Requiring an exact name match is what keeps these apart.
    const rows = [
      { symbol: 'SM', name: 'SM Energy Company', when: null },
      { symbol: 'SMA', name: 'SmartStop Self Storage REIT, Inc.', when: null },
    ];
    expect(mergeShareClasses(rows)).toHaveLength(2);
  });

  it('leaves single-class companies untouched', () => {
    const single = [{ symbol: 'AAPL', name: 'Apple Inc.', when: 'post' as const }];
    expect(mergeShareClasses(single)).toEqual(single);
    expect(mergeShareClasses(single)[0].alsoTradesAs).toBeUndefined();
  });
});

describe('parseEarnings', () => {
  const json = {
    data: {
      rows: [
        { symbol: 'SMALL', name: 'Small Co', time: 'time-not-supplied', marketCap: '$1,000,000', epsForecast: '($0.10)' },
        { symbol: 'LLY', name: 'Eli Lilly and Company', time: 'time-pre-market', marketCap: '$1,087,683,071,688', epsForecast: '$6.71', lastYearEPS: '$6.31', noOfEsts: '4' },
        { symbol: 'MID', name: 'Mid Co', time: 'time-after-hours', marketCap: '$50,000,000,000' },
        { symbol: 'NOCAP', name: 'Unknown Cap', time: 'time-pre-market', marketCap: '' },
      ],
    },
  };

  it('ranks by market cap and truncates', () => {
    const top2 = parseEarnings(json, 2);
    expect(top2.map((e) => e.symbol)).toEqual(['LLY', 'MID']);
  });

  it('merges share classes before the cut, not after', () => {
    // Otherwise a dual-class company eats two of the ranked slots.
    const dual = {
      data: {
        rows: [
          { symbol: 'BRK.A', name: 'Berkshire Hathaway Inc.', marketCap: '$1,100,000,000,000' },
          { symbol: 'BRK.B', name: 'Berkshire Hathaway Inc.', marketCap: '$1,100,000,000,000', epsForecast: '$5.24' },
          { symbol: 'VST', name: 'Vistra Corp.', marketCap: '$50,000,000,000' },
        ],
      },
    };
    const top2 = parseEarnings(dual, 2);
    expect(top2.map((e) => e.symbol)).toEqual(['BRK.B', 'VST']);
  });

  it('parses every field of the top row', () => {
    expect(parseEarnings(json, 1)[0]).toEqual({
      symbol: 'LLY',
      name: 'Eli Lilly and Company',
      when: 'pre',
      marketCap: 1_087_683_071_688,
      epsForecast: 6.71,
      lastYearEps: 6.31,
      estimateCount: 4,
    });
  });

  it('sorts unknown market caps last without dropping them', () => {
    const all = parseEarnings(json, 10);
    expect(all).toHaveLength(4);
    expect(all[all.length - 1].symbol).toBe('NOCAP');
  });

  it('counts the full day before truncation', () => {
    expect(countEarnings(json)).toBe(4);
    expect(parseEarnings(json, 2)).toHaveLength(2);
  });

  it('survives an empty or malformed day', () => {
    expect(parseEarnings({ data: { rows: null } }, 30)).toEqual([]);
    expect(parseEarnings({}, 30)).toEqual([]);
    expect(countEarnings({})).toBe(0);
  });
});

describe('buildCalendar', () => {
  const dates = ['2026-08-02', '2026-08-03', '2026-08-04'];
  const economic = [
    { id: 'b', name: 'CPI', country: 'US', at: '2026-08-04T12:30:00.000Z', importance: 'high' as const },
    { id: 'a', name: 'Jobless Claims', country: 'US', at: '2026-08-04T12:30:00.000Z', importance: 'medium' as const },
  ];
  const earnings = {
    '2026-08-03': {
      events: [{ symbol: 'X', name: 'X Co', when: null, marketCap: 1 }],
      total: 120,
    },
    '2026-08-04': { events: [], total: 0 },
  };
  const week = buildCalendar(dates, economic, earnings, 30);

  it('leaves economic events flat, not bucketed into days', () => {
    // Which day a UTC instant belongs to depends on the reader's timezone, so
    // the client does the bucketing. Grouping here would bake in the Worker's.
    expect(week.economic.map((e) => e.id)).toEqual(['b', 'a']);
    expect(week).not.toHaveProperty('days');
  });

  it('drops earnings days with nothing scheduled', () => {
    // 2026-08-02 is absent and 2026-08-04 is present but empty; neither should
    // render as a blank row.
    expect(week.earningsDays.map((d) => d.date)).toEqual(['2026-08-03']);
  });

  it('keeps the pre-truncation total so the UI can say "30 of N"', () => {
    expect(week.earningsDays[0].total).toBe(120);
    expect(week.earningsLimit).toBe(30);
  });

  it('reports the window even when everything is empty', () => {
    const empty = buildCalendar(dates, [], {}, 30);
    expect(empty.economic).toEqual([]);
    expect(empty.earningsDays).toEqual([]);
    expect(empty.from).toBe('2026-08-02');
    expect(empty.to).toBe('2026-08-04');
  });
});
