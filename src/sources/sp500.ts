import type { OhlcvPoint } from '../types';
import { withRetry } from '../lib/http';
import { fetchStooqHistory, SP500_STOOQ_SYMBOL } from './stooq';
import { fetchYahooHistory, SP500_YAHOO_SYMBOL } from './yahoo';

/** How much daily history the deep-dive loads (locked decision: ~20 years). */
export const SP500_HISTORY_YEARS = 20;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Load ~20 years of S&P 500 daily OHLCV. Stooq (CSV, no key) is primary; on any
 * failure — network, rate limit, empty payload — we fall back to Yahoo. `nowMs`
 * is injected for determinism/testability.
 */
export async function fetchSp500History(nowMs: number): Promise<OhlcvPoint[]> {
  const fromMs = nowMs - SP500_HISTORY_YEARS * YEAR_MS;
  try {
    return await fetchStooqHistory(SP500_STOOQ_SYMBOL, fromMs, nowMs);
  } catch (stooqErr) {
    try {
      // Yahoo throttles aggressively; back off rather than lose the day's prices.
      return await withRetry(() => fetchYahooHistory(SP500_YAHOO_SYMBOL, fromMs, nowMs));
    } catch (yahooErr) {
      throw new Error(
        `SP500 history unavailable (stooq: ${(stooqErr as Error).message}; ` +
          `yahoo: ${(yahooErr as Error).message})`,
      );
    }
  }
}
