import { API_BASE_URLS } from '../config';
import type { OhlcvPoint } from '../types';
import { getText } from '../lib/http';

const BASE = API_BASE_URLS.stooq;

/** Stooq ticker for the S&P 500 index (price index, not an ETF proxy). */
export const SP500_STOOQ_SYMBOL = '^spx';

// ---- Pure parsing (unit-tested) ----

/** `1950-01-03` → UTC epoch ms, or NaN if unparseable. */
function parseIsoDateUtc(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Parse a Stooq daily CSV (`Date,Open,High,Low,Close,Volume`) into ascending
 * OHLCV bars. Rows that don't parse (headers, "No data", blank, exceeded-limit
 * messages) are skipped rather than throwing, so a partially malformed payload
 * still yields whatever valid bars it contains.
 */
export function parseStooqCsv(csv: string): OhlcvPoint[] {
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2 || !/^date,/i.test(lines[0].trim())) return [];

  const out: OhlcvPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;

    const t = parseIsoDateUtc(cols[0]);
    const o = Number(cols[1]);
    const h = Number(cols[2]);
    const l = Number(cols[3]);
    const c = Number(cols[4]);
    const v = cols.length >= 6 ? Number(cols[5]) : 0;
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue;

    out.push({
      t,
      o: Number.isFinite(o) ? o : c,
      h: Number.isFinite(h) ? h : c,
      l: Number.isFinite(l) ? l : c,
      c,
      v: Number.isFinite(v) ? v : 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ---- Network ----

/** `1650499200000` → `20220421` (UTC), the date format Stooq's d1/d2 expect. */
function toStooqDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${mo}${day}`;
}

export function stooqUrl(symbol: string, fromMs: number, toMs: number): string {
  const params = new URLSearchParams({
    s: symbol,
    i: 'd',
    d1: toStooqDate(fromMs),
    d2: toStooqDate(toMs),
  });
  return `${BASE}/q/d/l/?${params.toString()}`;
}

/** Fetch daily OHLCV for `symbol` between two instants. Throws if no bars parse. */
export async function fetchStooqHistory(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<OhlcvPoint[]> {
  const csv = await getText(stooqUrl(symbol, fromMs, toMs));
  const points = parseStooqCsv(csv);
  if (points.length === 0) {
    throw new Error('Stooq returned no parseable rows');
  }
  return points;
}
