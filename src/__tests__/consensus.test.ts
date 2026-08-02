import { buildConsensus, buildMoves, type ConsensusInput } from '../domain/consensus';
import { aggregateHoldings, type HoldingChange, type Portfolio } from '../sources/edgar13f';

function portfolio(rows: Array<[string, number, number, string?]>): Portfolio {
  const { holdings, totalValue } = aggregateHoldings(
    rows.map(([cusip, value, shares, putCall]) => ({
      issuer: `${cusip} INC`,
      cusip,
      titleOfClass: 'COM',
      value,
      shares,
      sharesType: 'SH',
      putCall,
    })),
  );
  return {
    cik: '1',
    periodOfReport: '2026-03-31',
    filingDate: '2026-05-15',
    totalValue,
    holdings,
    rowCount: holdings.length,
  };
}

function input(
  investorId: string,
  manager: string,
  rows: Array<[string, number, number, string?]>,
  changes: Array<Partial<HoldingChange> & { cusip: string; kind: HoldingChange['kind'] }> = [],
  tickers: Record<string, string> = {},
): ConsensusInput {
  return {
    investorId,
    manager,
    portfolio: portfolio(rows),
    changes: changes.map((c) => ({
      issuer: `${c.cusip} INC`,
      sharesBefore: 0,
      sharesAfter: 0,
      value: 0,
      weightPct: 0,
      ...c,
    })) as HoldingChange[],
    tickers,
  };
}

describe('buildConsensus', () => {
  const inputs = [
    input('a', 'Alice', [['AAA', 600, 10], ['BBB', 400, 10]], [], { AAA: 'A' }),
    input('b', 'Bob', [['AAA', 300, 10], ['CCC', 700, 10]]),
    input('c', 'Carol', [['AAA', 100, 10]]),
  ];
  const entries = buildConsensus(inputs);
  const find = (cusip: string) => entries.find((e) => e.cusip === cusip)!;

  it('ranks by how many managers hold each stock', () => {
    expect(entries[0].cusip).toBe('AAA');
    expect(find('AAA').holderCount).toBe(3);
    expect(find('BBB').holderCount).toBe(1);
  });

  it('sums value and lists holders largest first', () => {
    expect(find('AAA').totalValue).toBe(1000);
    expect(find('AAA').holders.map((h) => h.manager)).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('averages weight across holders, not across all managers', () => {
    // Alice 60%, Bob 30%, Carol 100% -> mean of the three who hold it.
    expect(find('AAA').averageWeightPct).toBeCloseTo((60 + 30 + 100) / 3, 6);
  });

  it('picks up a ticker from whichever investor resolved it', () => {
    expect(find('AAA').ticker).toBe('A');
  });

  it('breaks holder-count ties by combined value', () => {
    // BBB (400) and CCC (700) are both held once; CCC must rank first.
    const oneHolder = entries.filter((e) => e.holderCount === 1).map((e) => e.cusip);
    expect(oneHolder).toEqual(['CCC', 'BBB']);
  });

  it('excludes options so a put is not counted as owning the stock', () => {
    const withPut = buildConsensus([
      input('a', 'Alice', [['AAA', 100, 10]]),
      input('b', 'Bob', [['AAA', 100, 10, 'Put']]),
    ]);
    expect(withPut.find((e) => e.cusip === 'AAA')!.holderCount).toBe(1);
  });

  it('handles an empty roster', () => {
    expect(buildConsensus([])).toEqual([]);
  });
});

describe('buildConsensus change tracking', () => {
  it('records who opened and who exited a position', () => {
    const entries = buildConsensus([
      input('a', 'Alice', [['AAA', 100, 10]], [{ cusip: 'AAA', kind: 'new' }]),
      input('b', 'Bob', [['AAA', 100, 10]], [{ cusip: 'AAA', kind: 'new' }]),
      input('c', 'Carol', [['BBB', 100, 10]], [{ cusip: 'AAA', kind: 'exit' }]),
    ]);
    const aaa = entries.find((e) => e.cusip === 'AAA')!;
    expect(aaa.newBuyers).toEqual(['Alice', 'Bob']);
    expect(aaa.sellers).toEqual(['Carol']);
  });

  it('still surfaces a stock everyone sold, despite nobody holding it', () => {
    // The exit has no current holding to attach to, so the entry must be created
    // from the change alone or the signal disappears entirely.
    const entries = buildConsensus([
      input('a', 'Alice', [['BBB', 100, 10]], [{ cusip: 'GONE', kind: 'exit' }]),
      input('b', 'Bob', [['BBB', 100, 10]], [{ cusip: 'GONE', kind: 'exit' }]),
    ]);
    const gone = entries.find((e) => e.cusip === 'GONE')!;
    expect(gone).toBeDefined();
    expect(gone.holderCount).toBe(0);
    expect(gone.sellers).toEqual(['Alice', 'Bob']);
  });

  it('ignores adds and trims — only opens and exits count as moves', () => {
    const entries = buildConsensus([
      input('a', 'Alice', [['AAA', 100, 10]], [{ cusip: 'AAA', kind: 'add' }]),
    ]);
    expect(entries[0].newBuyers).toEqual([]);
    expect(entries[0].sellers).toEqual([]);
  });
});

describe('buildMoves', () => {
  const entries = buildConsensus([
    input('a', 'Alice', [['AAA', 100, 10]], [{ cusip: 'AAA', kind: 'new' }]),
    input('b', 'Bob', [['AAA', 100, 10]], [{ cusip: 'AAA', kind: 'new' }]),
    input('c', 'Carol', [['BBB', 100, 10]], [{ cusip: 'BBB', kind: 'new' }]),
  ]);

  it('reports only stocks multiple managers moved on', () => {
    const moves = buildMoves(entries);
    expect(moves.mostBought.map((m) => m.issuer)).toEqual(['AAA INC']);
    expect(moves.mostBought[0].investors).toEqual(['Alice', 'Bob']);
  });

  it('respects a lower threshold when asked', () => {
    expect(buildMoves(entries, 1).mostBought).toHaveLength(2);
  });

  it('returns empty lists when nothing is shared', () => {
    expect(buildMoves([])).toEqual({ mostBought: [], mostSold: [] });
  });

  it('carries the cusip so dual share classes stay distinguishable', () => {
    // GOOGL and GOOG are both "ALPHABET INC". Keying UI rows on the issuer name
    // collides and React duplicates/omits rows; the cusip is the real identity.
    const dualClass = buildConsensus([
      input('a', 'Alice', [['GOOGL', 100, 10], ['GOOG', 100, 10]],
        [{ cusip: 'GOOGL', kind: 'new' }, { cusip: 'GOOG', kind: 'new' }]),
      input('b', 'Bob', [['GOOGL', 100, 10], ['GOOG', 100, 10]],
        [{ cusip: 'GOOGL', kind: 'new' }, { cusip: 'GOOG', kind: 'new' }]),
    ]);
    const bought = buildMoves(dualClass).mostBought;
    expect(bought).toHaveLength(2);
    expect(new Set(bought.map((m) => m.cusip)).size).toBe(2);
  });
});
