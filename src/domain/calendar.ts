import type { EconomicEvent } from '../sources/economicCalendar';
import type { EarningsEvent } from '../sources/earnings';

/**
 * Assembly of the week-ahead calendar. Pure: the refresh job fetches, this
 * arranges.
 */

/** Earnings for one US trading session. */
export interface EarningsDay {
  /** YYYY-MM-DD, the US market date. */
  date: string;
  events: EarningsEvent[];
  /** Companies reporting that day in total, before the size cut. */
  total: number;
}

export interface CalendarWeek {
  from: string;
  to: string;
  /**
   * Flat and chronological, NOT grouped into days.
   *
   * Each event carries a UTC instant, and which calendar day that falls on
   * depends on the reader: a release at 23:00 UTC is tonight in London and
   * tomorrow morning in Tokyo. Grouping here would bake one timezone —
   * whichever the Worker happened to use — into the payload and leave the day
   * headings wrong for most of the world. The client buckets by its own local
   * date instead.
   */
  economic: EconomicEvent[];
  /**
   * Earnings stay grouped, because their date is not an instant.
   *
   * "Apple reports on the 5th, after the close" is a statement about a US
   * trading session, and it means the same thing in every timezone. Converting
   * it to local time would invent precision the source never had.
   */
  earningsDays: EarningsDay[];
  /** How many earnings each day was truncated to. */
  earningsLimit: number;
}

/** UTC date `n` days from `fromMs`, as YYYY-MM-DD. */
export function isoDate(fromMs: number, offsetDays = 0): string {
  return new Date(fromMs + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** The window the calendar covers: today plus the next `days` days, inclusive. */
export function weekWindow(nowMs: number, days = 7): { from: string; to: string; dates: string[] } {
  const dates = Array.from({ length: days + 1 }, (_, i) => isoDate(nowMs, i));
  return { from: dates[0], to: dates[dates.length - 1], dates };
}

/**
 * Assemble the week.
 *
 * Earnings days with nothing on them are dropped rather than rendered empty: a
 * quiet week should look short, not padded with blank rows. Economic events
 * pass through in the order the source module sorted them — chronological, with
 * high importance first among events sharing an instant.
 */
export function buildCalendar(
  dates: string[],
  economic: EconomicEvent[],
  earningsByDate: Record<string, { events: EarningsEvent[]; total: number }>,
  earningsLimit: number,
): CalendarWeek {
  const earningsDays: EarningsDay[] = [];
  for (const date of dates) {
    const day = earningsByDate[date];
    if (!day || day.events.length === 0) continue;
    earningsDays.push({ date, events: day.events, total: day.total });
  }

  return {
    from: dates[0],
    to: dates[dates.length - 1],
    economic,
    earningsDays,
    earningsLimit,
  };
}
