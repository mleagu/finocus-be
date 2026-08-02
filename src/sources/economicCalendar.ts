import { API_BASE_URLS } from '../config';
import { getJson } from '../lib/http';

/**
 * Global economic calendar, from TradingView's calendar endpoint.
 *
 * REPLACED FRED. FRED is the Federal Reserve's own database, so it is US-only
 * by construction, publishes a DATE but never a TIME (release times had to be
 * hardcoded per agency from their standing schedules), and carries no analyst
 * forecasts. This endpoint gives all three — worldwide coverage, a real UTC
 * instant per event, and forecast/previous/actual values — which is what makes
 * client-local times possible at all. FRED is still used for the macro
 * snapshot; it is only the calendar that moved.
 *
 * UNDOCUMENTED, AND THE HEADERS ARE LOAD-BEARING. This is the endpoint
 * TradingView's own calendar widget calls. Without an `Origin`/`Referer` pair
 * it returns 403 — verified: the identical URL is 403 bare and 200 with them.
 * Same class of dependency as the Yahoo chart feed this Worker already leans
 * on, and it can break without notice. `/debug/egress` covers it so a failure
 * is diagnosable rather than mysterious.
 */

export type Importance = 'high' | 'medium';

export interface EconomicEvent {
  /** TradingView's own event id. Globally unique — see the note below. */
  id: string;
  name: string;
  /** ISO-3166 alpha-2, plus the pseudo-code 'EU' for euro-area releases. */
  country: string;
  /**
   * The release instant, ISO 8601 UTC.
   *
   * An absolute instant rather than a wall-clock string, so the client can
   * render it in the device's timezone. The old shape carried "08:30" plus an
   * implied US/Eastern, which cannot be converted without also knowing the
   * date's DST state.
   */
  at: string;
  importance: Importance;
  /** Reference period, e.g. "Jun" or "Q2". */
  period?: string;
  /** Preformatted for display, scale and unit already applied: "7.25M", "4.3%". */
  previous?: string;
  forecast?: string;
  /** Present once a release has landed; absent for anything still upcoming. */
  actual?: string;
}

/**
 * Countries surfaced in the calendar: the majors plus the larger emerging
 * markets.
 *
 * One request covers every country, so widening this list costs no extra
 * subrequests — only payload.
 */
export const COUNTRIES = [
  'US', 'EU', 'GB', 'JP', 'CN', 'DE', 'CA', 'AU', 'NZ', 'CH',
  'IN', 'BR', 'MX', 'KR', 'ZA', 'TR', 'ID', 'SA',
] as const;

/**
 * TradingView grades events -1 (low), 0 (medium), 1 (high).
 *
 * Low is dropped. It is 70% of the feed and it is bill auctions, central bank
 * balance-sheet lines and regional Fed speeches — roughly 28 events a day,
 * which buries the handful that move an index.
 */
const IMPORTANCE_BY_RANK: Record<number, Importance> = { 1: 'high', 0: 'medium' };

/**
 * Sent on every calendar request. See the file header: without these the
 * endpoint 403s.
 */
export const TRADINGVIEW_HEADERS: Record<string, string> = {
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

interface RawEvent {
  id?: string;
  title?: string;
  country?: string;
  date?: string;
  importance?: number;
  period?: string;
  actual?: number | null;
  previous?: number | null;
  forecast?: number | null;
  /** '%', 'USD', … */
  unit?: string | null;
  /** 'K', 'M', 'B' — the multiplier the value is already expressed in. */
  scale?: string | null;
}

interface CalendarResponse {
  status?: string;
  result?: RawEvent[];
}

/**
 * Render a value the way the source intends it to read.
 *
 * `scale` ('K', 'M', 'B') and `unit` arrive as separate optional fields and
 * cannot simply be concatenated in that order: '%' follows the number but every
 * other unit the feed uses is a currency symbol — '$', 'C$', 'A$', '€' — which
 * belongs in front of it. Appending blindly produced "-0.79B$" for an
 * Indonesian trade balance.
 *
 * The minus sign stays outermost, so a negative balance reads "-$0.79B" rather
 * than "$-0.79B".
 */
export function formatValue(
  value: number | null | undefined,
  unit?: string | null,
  scale?: string | null,
): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;

  const sign = value < 0 ? '-' : '';
  const magnitude = `${Math.abs(value)}${scale ?? ''}`;
  return unit && unit !== '%'
    ? `${sign}${unit}${magnitude}`
    : `${sign}${magnitude}${unit ?? ''}`;
}

/**
 * Map the raw feed into calendar events, dropping low importance and anything
 * outside the window.
 *
 * Note `id` comes straight from the feed. The obvious alternative — keying on
 * date plus a slug of the name — collides: "Final Manufacturing PMI" lands on
 * the same day for three different countries in a typical week, and duplicate
 * React keys silently drop rows. That exact bug already cost this project once,
 * on the consensus screen.
 */
export function parseEconomicEvents(json: unknown, fromMs: number, toMs: number): EconomicEvent[] {
  const raw = (json as CalendarResponse)?.result ?? [];
  const out: EconomicEvent[] = [];

  for (const e of raw) {
    const importance = e.importance == null ? undefined : IMPORTANCE_BY_RANK[e.importance];
    if (!importance || !e.id || !e.title || !e.country || !e.date) continue;

    const ms = Date.parse(e.date);
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;

    out.push({
      id: e.id,
      name: e.title,
      country: e.country,
      at: new Date(ms).toISOString(),
      importance,
      period: e.period || undefined,
      previous: formatValue(e.previous, e.unit, e.scale),
      forecast: formatValue(e.forecast, e.unit, e.scale),
      actual: formatValue(e.actual, e.unit, e.scale),
    });
  }

  // Chronological, then high before medium when two land on the same instant —
  // 08:30 ET routinely carries four releases at once.
  const rank = { high: 0, medium: 1 } as const;
  return out.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      rank[a.importance] - rank[b.importance] ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Fetch the calendar for a date window. `from`/`to` are YYYY-MM-DD, inclusive.
 *
 * One request covers the whole window and every country, so this costs a single
 * subrequest regardless of how wide either gets.
 */
export async function fetchEconomicCalendar(from: string, to: string): Promise<EconomicEvent[]> {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);

  const params = new URLSearchParams({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    countries: COUNTRIES.join(','),
  });

  const json = await getJson<unknown>(`${API_BASE_URLS.tradingViewCalendar}/events?${params}`, {
    headers: TRADINGVIEW_HEADERS,
  });

  return parseEconomicEvents(json, fromMs, toMs);
}
