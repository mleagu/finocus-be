import { describe, expect, it } from 'vitest';
import { SUPERINVESTORS } from '../domain/superinvestors';
import { cursorAt, stepsPerCycle } from '../refresh';

/**
 * The refresh cursor is derived from wall time rather than stored in KV, which
 * removed two KV operations per cron tick. That trade is only sound if the
 * derivation actually visits every phase in order and covers the whole roster —
 * a bug here does not throw, it silently starves a phase forever. Hence tests
 * on the sequence itself rather than on any single value.
 *
 * The rotation only runs OUTSIDE the US extended session, since every in-session
 * tick is a `price` step. Rotation tests therefore anchor to a Saturday, where
 * the market is shut all day whatever the timezone maths does.
 */

const TICK = 10 * 60 * 1000;

/** 2026-08-08 is a Saturday — the whole day is out of session. */
const WEEKEND = Date.parse('2026-08-08T06:00:00Z');

/** First tick at or after `fromMs` that starts a cycle. */
function firstSlotZeroTick(fromMs: number): number {
  const total = stepsPerCycle();
  const tick = Math.ceil(fromMs / TICK);
  return tick + ((total - (tick % total)) % total);
}

/** One full rotation cycle, entirely within the weekend. */
function oneCycle(startTick = firstSlotZeroTick(WEEKEND)) {
  return Array.from({ length: stepsPerCycle() }, (_, i) => cursorAt((startTick + i) * TICK));
}

describe('cursorAt — rotation, out of session', () => {
  it('covers market, every investor batch, consensus and calendar', () => {
    const phases = oneCycle().map((c) => c.phase);
    expect(phases[0]).toBe('market');
    expect(phases[phases.length - 2]).toBe('consensus');
    expect(phases[phases.length - 1]).toBe('calendar');
    expect(phases.filter((p) => p === 'investors')).toHaveLength(stepsPerCycle() - 3);
    expect(phases).not.toContain('price');
  });

  it('walks the whole roster exactly once per cycle, with no gaps', () => {
    const covered = new Set<string>();
    for (const cursor of oneCycle()) {
      if (cursor.phase !== 'investors') continue;
      for (const s of SUPERINVESTORS.slice(cursor.index, cursor.index + 2)) covered.add(s.id);
    }
    expect(covered.size).toBe(SUPERINVESTORS.length);
  });

  it('starts investor batches at 0 and steps by the batch size', () => {
    const indices = oneCycle()
      .filter((c) => c.phase === 'investors')
      .map((c) => c.index);
    expect(indices[0]).toBe(0);
    expect(indices).toEqual(indices.map((_, i) => i * 2));
  });

  it('repeats the same sequence on the next cycle', () => {
    const start = firstSlotZeroTick(WEEKEND);
    const total = stepsPerCycle();
    const first = oneCycle(start).map((c) => `${c.phase}:${c.index}`);
    const second = oneCycle(start + total).map((c) => `${c.phase}:${c.index}`);
    expect(second).toEqual(first);
  });

  it('never returns an index past the end of the roster', () => {
    for (const cursor of oneCycle()) {
      if (cursor.phase === 'investors') expect(cursor.index).toBeLessThan(SUPERINVESTORS.length);
    }
  });

  it('reaches every rotation phase within one night of out-of-session ticks', () => {
    // 20:00–04:00 ET is 48 consecutive ticks at a 10-minute cron, comfortably
    // more than the cycle length — this is what makes it safe to hand the whole
    // trading day to `price`.
    const seen = new Set<string>();
    // Exactly the closed window: 20:00 ET through 03:50 ET, the last tick
    // before pre-market reopens.
    const start = Date.parse('2026-08-05T00:00:00Z') / TICK; // 20:00 ET Tue
    for (let i = 0; i < 48; i++) seen.add(cursorAt((start + i) * TICK).phase);
    expect([...seen].sort()).toEqual(['calendar', 'consensus', 'investors', 'market']);
  });
});

describe('cursorAt — price, in session', () => {
  it('runs price on every tick during the extended session', () => {
    // 14:30Z on a Wednesday is 10:30 ET, mid regular session.
    const start = Math.ceil(Date.parse('2026-08-05T14:30:00Z') / TICK);
    for (let i = 0; i < 12; i++) {
      expect(cursorAt((start + i) * TICK).phase).toBe('price');
    }
  });

  it('covers pre-market and after-hours, not just the regular session', () => {
    expect(cursorAt(Date.parse('2026-08-05T08:10:00Z')).phase).toBe('price'); // 04:10 ET
    expect(cursorAt(Date.parse('2026-08-05T23:50:00Z')).phase).toBe('price'); // 19:50 ET
  });

  it('hands the clock back to the rotation once the session closes', () => {
    expect(cursorAt(Date.parse('2026-08-06T00:10:00Z')).phase).not.toBe('price'); // 20:10 ET
    expect(cursorAt(Date.parse('2026-08-05T07:50:00Z')).phase).not.toBe('price'); // 03:50 ET
  });

  it('never runs price at the weekend', () => {
    for (let i = 0; i < 144; i++) {
      expect(cursorAt(WEEKEND + i * TICK).phase).not.toBe('price');
    }
  });
});
