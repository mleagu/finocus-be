import { API_BASE_URLS } from '../config';
import type { OhlcvPoint } from '../types';
import { getJson } from '../lib/http';

const BASE = API_BASE_URLS.yahoo;

/** Yahoo Finance symbol for the S&P 500 index. */
export const SP500_YAHOO_SYMBOL = '^GSPC';

// ---- Raw Yahoo chart response shape (only the fields we read) ----

export interface YahooChartResponse {
  chart: {
    result?: Array<{
      timestamp?: number[]; // seconds
      indicators: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: unknown;
  };
}

// ---- Pure parsing (unit-tested) ----

function num(value: number | null | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

/**
 * Map a Yahoo v8 chart response to ascending OHLCV bars. Days where `close` is
 * null (Yahoo emits gaps for holidays) are dropped; o/h/l fall back to close and
 * volume to 0 when individually null.
 */
export function parseYahooChart(json: YahooChartResponse): OhlcvPoint[] {
  const result = json?.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!result || !ts || !q) return [];

  const out: OhlcvPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null || !Number.isFinite(c)) continue;
    out.push({
      t: ts[i] * 1000,
      o: num(q.open?.[i], c),
      h: num(q.high?.[i], c),
      l: num(q.low?.[i], c),
      c,
      v: num(q.volume?.[i], 0),
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- Network ----

export function yahooUrl(symbol: string, fromMs: number, toMs: number): string {
  const params = new URLSearchParams({
    period1: String(Math.floor(fromMs / 1000)),
    period2: String(Math.floor(toMs / 1000)),
    interval: '1d',
  });
  return `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?${params.toString()}`;
}

/**
 * Yahoo rejects the Workers runtime's default User-Agent with a 429.
 *
 * This is NOT a rate limit, despite the status code — it is refused in ~60ms,
 * before any quota could plausibly be consulted, and the identical request with
 * a browser User-Agent returns real data from the same IP. Verified from a
 * deployed Worker: default UA 429, browser UA 200. Without this header the whole
 * price pipeline is dead on Cloudflare, so do not "simplify" it away.
 */
const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

/** Fetch daily OHLCV for `symbol` between two instants. Throws if no bars parse. */
export async function fetchYahooHistory(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<OhlcvPoint[]> {
  const json = await getJson<YahooChartResponse>(yahooUrl(symbol, fromMs, toMs), {
    headers: YAHOO_HEADERS,
  });
  const points = parseYahooChart(json);
  if (points.length === 0) {
    throw new Error('Yahoo returned no parseable bars');
  }
  return points;
}
