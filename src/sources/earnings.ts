import { getJson } from '../lib/http';

/**
 * Earnings calendar from Nasdaq's public calendar endpoint.
 *
 * Chosen over Alpha Vantage and Finnhub for one reason: it is the only free
 * source that returns MARKET CAP, which is what makes "the 30 that matter" a
 * one-line filter instead of a second data source. It also carries pre/post
 * timing, the consensus EPS estimate and last year's actual.
 *
 * Caveat worth knowing: this endpoint is public but undocumented, so it carries
 * more breakage risk than SEC or FRED. Verified reachable from Cloudflare's
 * egress (200, with and without a browser User-Agent). If it ever disappears,
 * Alpha Vantage's EARNINGS_CALENDAR is the fallback — but it has no market cap,
 * so the ranking would need rethinking rather than a straight swap.
 */

const BASE = 'https://api.nasdaq.com/api/calendar/earnings';

/** Nasdaq rejects some datacenter clients without a browser-ish agent. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export interface EarningsEvent {
  symbol: string;
  name: string;
  /**
   * Other share classes of the same company reporting the same day, e.g. BRK.A
   * alongside BRK.B. Collapsed into one row because the company reports once.
   */
  alsoTradesAs?: string[];
  /** Trading-session timing; null when the company hasn't said. */
  when: 'pre' | 'post' | null;
  /** Market capitalisation in USD. */
  marketCap?: number;
  /** Consensus EPS estimate for the quarter. */
  epsForecast?: number;
  /** Same quarter last year, for a like-for-like comparison. */
  lastYearEps?: number;
  /** How many analysts contributed to the estimate. */
  estimateCount?: number;
}

interface NasdaqRow {
  symbol?: string;
  name?: string;
  time?: string;
  marketCap?: string;
  epsForecast?: string;
  lastYearEPS?: string;
  noOfEsts?: string;
}

interface NasdaqResponse {
  data?: { rows?: NasdaqRow[] | null };
}

/**
 * Parse Nasdaq's money strings.
 *
 * Negatives are written in accounting parentheses — "($1.93)" means -1.93 — and
 * a third of rows on a typical day carry a negative estimate or prior-year
 * actual. Treating the parentheses as noise silently flips the sign on all of
 * them, turning losses into profits on screen.
 */
export function parseMoney(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const negative = raw.includes('(') && raw.includes(')');
  const digits = raw.replace(/[^0-9.]/g, '');
  if (!digits) return undefined;
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  return negative ? -value : value;
}

/** "time-pre-market" | "time-after-hours" | "time-not-supplied" */
export function parseWhen(raw: string | undefined): 'pre' | 'post' | null {
  if (raw === 'time-pre-market') return 'pre';
  if (raw === 'time-after-hours') return 'post';
  return null;
}

/**
 * Collapse multiple share classes of one company into a single row.
 *
 * Nasdaq lists each class separately — BRK.A and BRK.B, PBR and PBR.A, GOOGL and
 * GOOG — but the company reports once, so two rows is both wrong and wasteful of
 * the size-ranked slots. Grouping is by company name, which Nasdaq gives
 * identically across classes.
 *
 * The surviving class is the one with analyst coverage: a forecast beats none,
 * then more estimates wins. On real data that picks BRK.B over BRK.A and PBR
 * over PBR.A — in both cases the class people actually track.
 */
export function mergeShareClasses(events: EarningsEvent[]): EarningsEvent[] {
  const byCompany = new Map<string, EarningsEvent[]>();
  for (const e of events) {
    const key = e.name.toLowerCase();
    byCompany.set(key, [...(byCompany.get(key) ?? []), e]);
  }

  return [...byCompany.values()].map((group) => {
    if (group.length === 1) return group[0];
    const ranked = [...group].sort(
      (a, b) =>
        Number(b.epsForecast != null) - Number(a.epsForecast != null) ||
        (b.estimateCount ?? 0) - (a.estimateCount ?? 0) ||
        a.symbol.localeCompare(b.symbol),
    );
    const [primary, ...rest] = ranked;
    return { ...primary, alsoTradesAs: rest.map((e) => e.symbol) };
  });
}

/**
 * Parse a day's rows and keep the largest `limit` by market cap.
 *
 * Nasdaq lists ~500 companies on a busy day, the overwhelming majority of them
 * microcaps nobody is watching. Ranking by size and cutting to a few dozen is
 * what makes the day readable; rows with no market cap sort last rather than
 * being dropped, since a missing field shouldn't erase a real event.
 *
 * Share classes are merged BEFORE the cut, so a dual-class company consumes one
 * slot rather than two.
 */
export function parseEarnings(json: unknown, limit: number): EarningsEvent[] {
  const rows = (json as NasdaqResponse)?.data?.rows ?? [];
  if (!Array.isArray(rows)) return [];

  const events = rows
    .filter((r): r is NasdaqRow & { symbol: string } => Boolean(r?.symbol))
    .map((r) => ({
      symbol: r.symbol.trim().toUpperCase(),
      name: (r.name ?? r.symbol).trim(),
      when: parseWhen(r.time),
      marketCap: parseMoney(r.marketCap),
      epsForecast: parseMoney(r.epsForecast),
      lastYearEps: parseMoney(r.lastYearEPS),
      estimateCount: r.noOfEsts ? Number(r.noOfEsts) || undefined : undefined,
    }));

  return mergeShareClasses(events)
    .sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1))
    .slice(0, limit);
}

/** Total companies reporting that day, before the size cut. */
export function countEarnings(json: unknown): number {
  const rows = (json as NasdaqResponse)?.data?.rows;
  return Array.isArray(rows) ? rows.length : 0;
}

export interface DayEarnings {
  events: EarningsEvent[];
  /** How many reported in total, so the UI can say "30 of 489". */
  total: number;
}

/** Fetch one day. `date` is YYYY-MM-DD. */
export async function fetchEarningsForDate(date: string, limit: number): Promise<DayEarnings> {
  const json = await getJson<unknown>(`${BASE}?date=${date}`, { headers: HEADERS });
  return { events: parseEarnings(json, limit), total: countEarnings(json) };
}
