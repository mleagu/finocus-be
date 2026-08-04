import { describe, expect, it } from 'vitest';
import { isExtendedTradingHours, newYorkTime } from '../domain/marketHours';

/**
 * The daylight-saving cases are the point of these tests. A fixed UTC offset
 * passes every summer check and is silently an hour wrong all winter, which
 * would open the session an hour late for four months without anything failing.
 */

/** An instant from a New York wall-clock time, given the UTC offset that day. */
const ny = (iso: string, offsetHours: number) => {
  const sign = offsetHours < 0 ? '-' : '+';
  const pad = String(Math.abs(offsetHours)).padStart(2, '0');
  return Date.parse(`${iso}:00${sign}${pad}:00`);
};

describe('newYorkTime', () => {
  it('reads EDT (UTC-4) in summer', () => {
    expect(newYorkTime(Date.parse('2026-07-15T18:30:00Z'))).toEqual({
      weekday: 'Wed',
      minutes: 14 * 60 + 30,
    });
  });

  it('reads EST (UTC-5) in winter', () => {
    expect(newYorkTime(Date.parse('2026-01-15T18:30:00Z'))).toEqual({
      weekday: 'Thu',
      minutes: 13 * 60 + 30,
    });
  });

  it('normalises midnight to 0 rather than 24', () => {
    expect(newYorkTime(Date.parse('2026-07-15T04:00:00Z')).minutes).toBe(0);
  });
});

describe('isExtendedTradingHours', () => {
  it('covers pre-market, regular session and after-hours on a weekday', () => {
    for (const [time, expected] of [
      ['T03:59', false], // before pre-market
      ['T04:00', true], // pre-market opens
      ['T09:30', true], // regular session
      ['T16:00', true], // after-hours
      ['T19:59', true], // last minute
      ['T20:00', false], // closed
      ['T23:30', false],
    ] as const) {
      expect(isExtendedTradingHours(ny(`2026-07-15${time}`, -4))).toBe(expected);
    }
  });

  it('is closed all weekend', () => {
    for (const day of ['2026-07-18', '2026-07-19']) {
      expect(isExtendedTradingHours(ny(`${day}T12:00`, -4))).toBe(false);
    }
  });

  it('opens at 04:00 local in winter too, not 05:00', () => {
    // The DST trap: -5 in January. Using a summer offset here would read 03:00
    // and report the market closed during the first hour of pre-market.
    expect(isExtendedTradingHours(ny('2026-01-15T04:00', -5))).toBe(true);
    expect(isExtendedTradingHours(ny('2026-01-15T03:59', -5))).toBe(false);
  });

  it('tracks the spring-forward changeover', () => {
    // 2026-03-08 is the US switch to EDT. 09:30 local is 14:30Z after it.
    expect(isExtendedTradingHours(Date.parse('2026-03-09T13:30:00Z'))).toBe(true);
    // The same UTC instant a week earlier is 08:30 EST — still open (pre-market).
    expect(isExtendedTradingHours(Date.parse('2026-03-02T13:30:00Z'))).toBe(true);
    // 08:30Z is 03:30 EST, before pre-market.
    expect(isExtendedTradingHours(Date.parse('2026-03-02T08:30:00Z'))).toBe(false);
  });
});
