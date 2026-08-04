/**
 * Is the US market in its extended session right now?
 *
 * Used to decide whether `/v1/market` should spend a live price fetch. Outside
 * these hours the last close is the current price by definition, so refetching
 * buys nothing and only burns upstream quota.
 *
 * WHY Intl RATHER THAN A UTC OFFSET: New York is UTC-5 or UTC-4 depending on
 * daylight saving, and the changeover dates differ from Europe's. A hardcoded
 * offset is correct for most of the year and silently an hour wrong for the
 * rest — which would open the session an hour late every spring. Workers ship a
 * full ICU build, so the timezone database is available and authoritative.
 *
 * HOLIDAYS ARE DELIBERATELY NOT MODELLED. A US market holiday calendar has to
 * be maintained by hand forever and is wrong the year you forget. The cost of
 * omitting it is one wasted fetch on roughly nine days a year, which returns
 * the previous close and is therefore harmless — a stale-data bug traded for a
 * negligible-waste bug.
 */

/** Pre-market opens 04:00 ET. */
const SESSION_START_MINUTES = 4 * 60;
/** After-hours ends 20:00 ET. */
const SESSION_END_MINUTES = 20 * 60;

const NY_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKEND = new Set(['Sat', 'Sun']);

/** New York wall-clock weekday and minute-of-day for an instant. */
export function newYorkTime(nowMs: number): { weekday: string; minutes: number } {
  const parts = NY_PARTS.formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` yields 24 for midnight in some ICU versions; normalise.
  const hour = Number(get('hour')) % 24;
  return { weekday: get('weekday'), minutes: hour * 60 + Number(get('minute')) };
}

/**
 * True between 04:00 and 20:00 New York time on a weekday — pre-market, the
 * regular session, and after-hours.
 */
export function isExtendedTradingHours(nowMs: number): boolean {
  const { weekday, minutes } = newYorkTime(nowMs);
  if (WEEKEND.has(weekday)) return false;
  return minutes >= SESSION_START_MINUTES && minutes < SESSION_END_MINUTES;
}
