import { BERKSHIRE_13F_XML } from '../__fixtures__/berkshire13f';
import {
  accessionPath,
  aggregateHoldings,
  diffPortfolios,
  padCik,
  parseFilings,
  parseInformationTable,
  pickInformationTable,
  valueScale,
  type Portfolio,
} from '../sources/edgar13f';

const FIXTURE = BERKSHIRE_13F_XML;
const PERIOD = '2026-03-31';

describe('padCik / accessionPath', () => {
  it('zero-pads CIKs to 10 digits', () => {
    expect(padCik('1067983')).toBe('0001067983');
    expect(padCik('0001067983')).toBe('0001067983');
    expect(padCik('CIK1067983')).toBe('0001067983');
  });

  it('strips dashes from accession numbers', () => {
    expect(accessionPath('0001193125-26-226661')).toBe('000119312526226661');
  });
});

describe('valueScale', () => {
  it('treats modern filings as whole dollars', () => {
    expect(valueScale('2026-03-31')).toBe(1);
    expect(valueScale('2022-12-31')).toBe(1);
  });

  it('treats pre-amendment filings as thousands', () => {
    expect(valueScale('2022-09-30')).toBe(1000);
    expect(valueScale('2015-06-30')).toBe(1000);
  });
});

describe('parseFilings', () => {
  const json = {
    filings: {
      recent: {
        form: ['13F-HR', '10-K', '13F-HR', '13F-HR/A', '13F-HR'],
        accessionNumber: ['acc-1', 'acc-x', 'acc-2', 'acc-3', 'acc-4'],
        filingDate: ['2026-05-15', '2026-02-01', '2026-02-17', '2025-12-01', '2025-11-14'],
        reportDate: ['2026-03-31', '2025-12-31', '2025-12-31', '2025-09-30', '2025-09-30'],
      },
    },
  };

  it('keeps only 13F filings, newest quarter first', () => {
    const filings = parseFilings(json);
    expect(filings.map((f) => f.periodOfReport)).toEqual([
      '2026-03-31',
      '2025-12-31',
      '2025-09-30',
    ]);
  });

  it('prefers the amendment when a quarter was restated', () => {
    // acc-3 is the 13F-HR/A for 2025-09-30 and is listed before the original.
    expect(parseFilings(json).find((f) => f.periodOfReport === '2025-09-30')?.form).toBe(
      '13F-HR/A',
    );
  });

  it('returns an empty list for a filer with no 13Fs', () => {
    expect(parseFilings({ filings: { recent: { form: ['10-K'] } } })).toEqual([]);
    expect(parseFilings({})).toEqual([]);
    expect(parseFilings(null)).toEqual([]);
  });
});

describe('pickInformationTable', () => {
  it('skips the cover page and its XSL rendering', () => {
    const index = {
      directory: {
        item: [
          { name: '0001193125-26-226661-index.html' },
          { name: 'primary_doc.xml' },
          { name: 'xslForm13F_X02/primary_doc.xml' },
          { name: '53405.xml' },
        ],
      },
    };
    expect(pickInformationTable(index)).toBe('53405.xml');
  });

  it('returns undefined when the directory has no information table', () => {
    expect(pickInformationTable({ directory: { item: [{ name: 'primary_doc.xml' }] } })).toBeUndefined();
    expect(pickInformationTable({})).toBeUndefined();
  });
});

describe('parseInformationTable', () => {
  it('parses every row of the real filing', () => {
    const rows = parseInformationTable(FIXTURE, PERIOD);
    expect(rows).toHaveLength(28);
    expect(rows[0]).toMatchObject({
      issuer: 'ALLY FINL INC',
      cusip: '02005N100',
      titleOfClass: 'COM',
      sharesType: 'SH',
    });
  });

  it('reads values as dollars, not thousands', () => {
    const apple = parseInformationTable(FIXTURE, PERIOD).filter((r) => r.cusip === '037833100');
    const value = apple.reduce((sum, r) => sum + r.value, 0);
    // ~$57.8B across 227.9M shares ≈ $254/share — a sane Apple price. Under the
    // legacy thousands assumption this would come out at $57.8 trillion.
    expect(value).toBe(57_843_260_493);
    expect(value / apple.reduce((s, r) => s + r.shares, 0)).toBeGreaterThan(50);
  });

  it('scales pre-2023 filings up from thousands', () => {
    const modern = parseInformationTable(FIXTURE, '2026-03-31')[0].value;
    const legacy = parseInformationTable(FIXTURE, '2019-06-30')[0].value;
    expect(legacy).toBe(modern * 1000);
  });

  it('tolerates namespace-prefixed tags', () => {
    const prefixed = FIXTURE.replace(/<(\/?)(infoTable|nameOfIssuer|cusip|value)\b/g, '<$1ns1:$2');
    expect(parseInformationTable(prefixed, PERIOD)).toHaveLength(28);
    expect(parseInformationTable(prefixed, PERIOD)[0].cusip).toBe('02005N100');
  });

  it('returns an empty list for junk input', () => {
    expect(parseInformationTable('', PERIOD)).toEqual([]);
    expect(parseInformationTable('<html>not a filing</html>', PERIOD)).toEqual([]);
  });
});

describe('aggregateHoldings', () => {
  const rows = parseInformationTable(FIXTURE, PERIOD);
  const { holdings, totalValue } = aggregateHoldings(rows);

  it('collapses the same CUSIP filed across multiple manager rows', () => {
    // The single most important behaviour here: 28 rows are only 3 positions.
    expect(rows).toHaveLength(28);
    expect(holdings).toHaveLength(3);
  });

  it('sums shares and value per position', () => {
    const apple = holdings.find((h) => h.cusip === '037833100')!;
    expect(apple.shares).toBe(227_917_808);
    expect(apple.value).toBe(57_843_260_493);

    const ko = holdings.find((h) => h.cusip === '191216100')!;
    expect(ko.shares).toBe(400_000_000);
  });

  it('sorts by value descending and weights to 100%', () => {
    expect(holdings.map((h) => h.cusip)).toEqual(['037833100', '191216100', '02005N100']);
    expect(totalValue).toBe(89_400_930_493);
    expect(holdings.reduce((s, h) => s + h.weightPct, 0)).toBeCloseTo(100, 6);
    expect(holdings[0].weightPct).toBeCloseTo((57_843_260_493 / 89_400_930_493) * 100, 6);
  });

  it('keeps options separate from the common stock of the same issuer', () => {
    const withPut = aggregateHoldings([
      { issuer: 'X', cusip: 'C1', titleOfClass: 'COM', value: 100, shares: 10, sharesType: 'SH' },
      {
        issuer: 'X',
        cusip: 'C1',
        titleOfClass: 'COM',
        value: 40,
        shares: 5,
        sharesType: 'SH',
        putCall: 'Put',
      },
    ]);
    expect(withPut.holdings).toHaveLength(2);
    expect(withPut.holdings.find((h) => h.putCall === 'Put')?.shares).toBe(5);
  });

  it('handles an empty filing without dividing by zero', () => {
    expect(aggregateHoldings([])).toEqual({ holdings: [], totalValue: 0 });
  });
});

describe('diffPortfolios', () => {
  const portfolio = (holdings: Array<[string, number, number]>): Portfolio => {
    const { holdings: hs, totalValue } = aggregateHoldings(
      holdings.map(([cusip, value, shares]) => ({
        issuer: cusip,
        cusip,
        titleOfClass: 'COM',
        value,
        shares,
        sharesType: 'SH',
      })),
    );
    return {
      cik: '1',
      periodOfReport: '2026-03-31',
      filingDate: '2026-05-15',
      totalValue,
      holdings: hs,
      rowCount: hs.length,
    };
  };

  const prev = portfolio([
    ['KEPT', 100, 100],
    ['ADDED', 100, 100],
    ['TRIMMED', 100, 100],
    ['SOLD', 100, 100],
  ]);
  const curr = portfolio([
    ['KEPT', 100, 100],
    ['ADDED', 200, 150],
    ['TRIMMED', 50, 60],
    ['BOUGHT', 300, 300],
  ]);
  const changes = diffPortfolios(curr, prev);
  const kindOf = (cusip: string) => changes.find((c) => c.cusip === cusip)!.kind;

  it('classifies new, exit, add, trim and hold', () => {
    expect(kindOf('BOUGHT')).toBe('new');
    expect(kindOf('SOLD')).toBe('exit');
    expect(kindOf('ADDED')).toBe('add');
    expect(kindOf('TRIMMED')).toBe('trim');
    expect(kindOf('KEPT')).toBe('hold');
  });

  it('reports the share-count delta', () => {
    expect(changes.find((c) => c.cusip === 'ADDED')!.sharesDeltaPct).toBeCloseTo(50);
    expect(changes.find((c) => c.cusip === 'TRIMMED')!.sharesDeltaPct).toBeCloseTo(-40);
    expect(changes.find((c) => c.cusip === 'BOUGHT')!.sharesDeltaPct).toBeUndefined();
  });

  it('includes exits with a zeroed current position', () => {
    const sold = changes.find((c) => c.cusip === 'SOLD')!;
    expect(sold).toMatchObject({ sharesBefore: 100, sharesAfter: 0, value: 0, weightPct: 0 });
  });

  it('treats a sub-0.5% share move as a hold, not a trim', () => {
    const noise = diffPortfolios(portfolio([['A', 100, 1000]]), portfolio([['A', 100, 1002]]));
    expect(noise[0].kind).toBe('hold');
  });

  it('orders new buys and exits ahead of adds and trims', () => {
    expect(changes.map((c) => c.kind).slice(0, 2)).toEqual(['new', 'exit']);
    expect(changes[changes.length - 1].kind).toBe('hold');
  });

  it('returns nothing when there is no prior quarter', () => {
    expect(diffPortfolios(curr, undefined)).toEqual([]);
  });
});
