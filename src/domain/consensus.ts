import type { HoldingChange, Portfolio } from '../sources/edgar13f';

/**
 * Cross-investor aggregation.
 *
 * This is the thing the phone could never do: answering "which stock do the most
 * superinvestors own?" means fetching and parsing 56 filings (28 managers x 2
 * quarters). Absurd on demand, trivial once a night — so it lives here rather
 * than in the app.
 *
 * All functions are pure; the refresh job feeds them portfolios it already has.
 */

/** One investor's stake in a stock, as seen from the consensus view. */
export interface ConsensusHolder {
  investorId: string;
  manager: string;
  value: number;
  /** Weight within that investor's own portfolio, 0-100. */
  weightPct: number;
}

/** A stock ranked by how many tracked managers hold it. */
export interface ConsensusEntry {
  cusip: string;
  issuer: string;
  ticker?: string;
  /** Number of tracked managers holding it. */
  holderCount: number;
  /** Combined reported value across those managers, USD. */
  totalValue: number;
  /**
   * Mean weight across the managers who hold it — a stock held at 20% by three
   * managers is a much stronger signal than one held at 0.3% by ten, and
   * holderCount alone cannot tell those apart.
   */
  averageWeightPct: number;
  /** Descending by value. */
  holders: ConsensusHolder[];
  /** Managers who opened this position in the most recent quarter. */
  newBuyers: string[];
  /** Managers who exited it in the most recent quarter. */
  sellers: string[];
}

export interface ConsensusInput {
  investorId: string;
  manager: string;
  portfolio: Portfolio;
  changes: HoldingChange[];
  /** CUSIP -> ticker, as resolved for this investor. */
  tickers: Record<string, string>;
}

/**
 * Rank every stock by how many tracked managers hold it.
 *
 * Options are excluded: a put is a bearish position, and counting it as
 * "holding" the underlying would invert the signal this view exists to give.
 */
export function buildConsensus(inputs: ConsensusInput[]): ConsensusEntry[] {
  const byCusip = new Map<string, ConsensusEntry>();

  for (const { investorId, manager, portfolio, changes, tickers } of inputs) {
    for (const h of portfolio.holdings) {
      if (h.putCall) continue;

      let entry = byCusip.get(h.cusip);
      if (!entry) {
        entry = {
          cusip: h.cusip,
          issuer: h.issuer,
          ticker: tickers[h.cusip],
          holderCount: 0,
          totalValue: 0,
          averageWeightPct: 0,
          holders: [],
          newBuyers: [],
          sellers: [],
        };
        byCusip.set(h.cusip, entry);
      }
      entry.ticker ??= tickers[h.cusip];
      entry.holderCount += 1;
      entry.totalValue += h.value;
      entry.holders.push({ investorId, manager, value: h.value, weightPct: h.weightPct });
    }

    for (const c of changes) {
      if (c.putCall) continue;
      const entry = byCusip.get(c.cusip);
      // An exit leaves no current holding, so the entry may not exist yet —
      // create a shell so "everyone sold X" is still visible.
      if (c.kind === 'exit') {
        const target =
          entry ??
          byCusip
            .set(c.cusip, {
              cusip: c.cusip,
              issuer: c.issuer,
              ticker: tickers[c.cusip],
              holderCount: 0,
              totalValue: 0,
              averageWeightPct: 0,
              holders: [],
              newBuyers: [],
              sellers: [],
            })
            .get(c.cusip)!;
        target.sellers.push(manager);
      } else if (c.kind === 'new' && entry) {
        entry.newBuyers.push(manager);
      }
    }
  }

  const entries = [...byCusip.values()];
  for (const e of entries) {
    e.holders.sort((a, b) => b.value - a.value);
    e.averageWeightPct = e.holders.length
      ? e.holders.reduce((s, h) => s + h.weightPct, 0) / e.holders.length
      : 0;
  }

  return entries.sort(
    (a, b) => b.holderCount - a.holderCount || b.totalValue - a.totalValue,
  );
}

/** One stock several managers moved on in the same quarter. */
export interface ConsensusMove {
  /**
   * Carried so clients have a stable identity. Issuer names are NOT unique —
   * dual share classes share one: GOOGL and GOOG are both "ALPHABET INC", which
   * is enough to collide as a React key and make rows duplicate on screen.
   */
  cusip: string;
  issuer: string;
  ticker?: string;
  investors: string[];
}

/** Quarter's aggregate activity, for the "what changed" view. */
export interface ConsensusMoves {
  mostBought: ConsensusMove[];
  mostSold: ConsensusMove[];
}

/** Stocks opened or exited by more than one tracked manager in the same quarter. */
export function buildMoves(entries: ConsensusEntry[], minInvestors = 2): ConsensusMoves {
  const pick = (key: 'newBuyers' | 'sellers') =>
    entries
      .filter((e) => e[key].length >= minInvestors)
      .sort((a, b) => b[key].length - a[key].length || b.totalValue - a.totalValue)
      .map((e) => ({ cusip: e.cusip, issuer: e.issuer, ticker: e.ticker, investors: e[key] }));

  return { mostBought: pick('newBuyers'), mostSold: pick('sellers') };
}
