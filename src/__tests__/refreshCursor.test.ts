import { describe, expect, it } from 'vitest';
import { SUPERINVESTORS } from '../domain/superinvestors';
import { cursorAt, stepsPerCycle } from '../refresh';

/**
 * The refresh cursor is derived from wall time rather than stored in KV, which
 * removed two KV operations per cron tick. That trade is only sound if the
 * derivation actually visits every phase in order and covers the whole roster —
 * a bug here does not throw, it silently starves a phase forever. Hence tests
 * on the sequence itself rather than on any single value.
 */

const MINUTE = 60 * 1000;
const TICK = 15 * MINUTE;

/** Every slot of one full cycle, in order. */
function oneCycle(startTick = 0) {
  return Array.from({ length: stepsPerCycle() }, (_, i) => cursorAt((startTick + i) * TICK));
}

describe('cursorAt', () => {
  it('covers market, every investor batch, consensus and calendar', () => {
    const phases = oneCycle().map((c) => c.phase);
    expect(phases[0]).toBe('market');
    expect(phases[phases.length - 2]).toBe('consensus');
    expect(phases[phases.length - 1]).toBe('calendar');
    expect(phases.filter((p) => p === 'investors')).toHaveLength(stepsPerCycle() - 3);
  });

  it('walks the whole roster exactly once per cycle, with no gaps', () => {
    const covered = new Set<string>();
    for (const cursor of oneCycle()) {
      if (cursor.phase !== 'investors') continue;
      // Mirrors the slice refreshStep takes.
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
    const total = stepsPerCycle();
    const first = oneCycle(0).map((c) => `${c.phase}:${c.index}`);
    const second = oneCycle(total).map((c) => `${c.phase}:${c.index}`);
    expect(second).toEqual(first);
  });

  it('bumps the cycle counter exactly once per cycle', () => {
    const total = stepsPerCycle();
    expect(cursorAt(0).cycle).toBe(0);
    expect(cursorAt((total - 1) * TICK).cycle).toBe(0);
    expect(cursorAt(total * TICK).cycle).toBe(1);
  });

  it('holds the same slot for the whole 15-minute window', () => {
    // A cron that fires a few seconds late must not land in the next slot and
    // skip a phase.
    const base = cursorAt(3 * TICK);
    expect(cursorAt(3 * TICK + 1)).toEqual(base);
    expect(cursorAt(3 * TICK + 14 * MINUTE + 59 * 1000)).toEqual(base);
    expect(cursorAt(4 * TICK).phase === base.phase && cursorAt(4 * TICK).index === base.index).toBe(
      false,
    );
  });

  it('never returns an index past the end of the roster', () => {
    for (const cursor of oneCycle()) {
      if (cursor.phase === 'investors') expect(cursor.index).toBeLessThan(SUPERINVESTORS.length);
    }
  });
});
