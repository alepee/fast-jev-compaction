import { describe, expect, it } from 'vitest';
import { cacheLine, createCacheMeter, median, type TurnSample } from '../src/index.js';
import { turnSample } from '../hooks/keep-the-thread.ts';

function turn(cacheWrite: number, usd?: number): TurnSample {
  const sample: TurnSample = { cacheWrite, cacheRead: 40_000, input: 12, output: 400 };
  if (usd !== undefined) sample.usd = usd;
  return sample;
}

describe('median', () => {
  it('is the middle of an odd run and the mean of the two middles of an even one', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('createCacheMeter', () => {
  it('says nothing until a compaction has been marked', () => {
    const meter = createCacheMeter();
    expect(meter.record(turn(3000))).toBeUndefined();
    expect(meter.totals.compactions).toBe(0);
  });

  it('attributes the excess cache write of the next turn to the compaction', () => {
    const meter = createCacheMeter();
    for (const write of [3000, 4000, 3500, 12_000, 3200]) meter.record(turn(write));
    meter.markCompaction(21);
    const verdict = meter.record(turn(62_000));
    expect(verdict).toBeDefined();
    // The median ignores the one heavy turn a mean would have hidden it behind.
    expect(verdict?.baselineCacheWrite).toBe(3500);
    expect(verdict?.excessCacheWrite).toBe(58_500);
    expect(verdict?.pointsFreed).toBe(21);
    expect(meter.totals).toMatchObject({ compactions: 1, excessCacheWrite: 58_500, pointsFreed: 21 });
  });

  it('measures only the turn that follows the compaction', () => {
    const meter = createCacheMeter();
    meter.record(turn(3000));
    meter.markCompaction(10);
    meter.record(turn(50_000));
    expect(meter.record(turn(3000))).toBeUndefined();
  });

  it('keeps the rewrite turn out of the next baseline', () => {
    const meter = createCacheMeter();
    for (const write of [2000, 2000, 2000]) meter.record(turn(write));
    meter.markCompaction();
    meter.record(turn(80_000));
    meter.markCompaction();
    // Still 2000: the 80k turn never entered the window.
    expect(meter.record(turn(50_000))?.baselineCacheWrite).toBe(2000);
  });

  it('prices the compaction from the ledger delta, never a rate table', () => {
    const meter = createCacheMeter();
    for (const usd of [0.05, 0.06, 0.05]) meter.record(turn(3000, usd));
    meter.markCompaction(18);
    const verdict = meter.record(turn(60_000, 0.47));
    expect(verdict?.baselineUsd).toBeCloseTo(0.05, 5);
    expect(verdict?.excessUsd).toBeCloseTo(0.42, 5);
    expect(meter.totals.excessUsd).toBeCloseTo(0.42, 5);
  });

  it('leaves the money out when the host keeps no ledger', () => {
    const meter = createCacheMeter();
    meter.record(turn(3000));
    meter.markCompaction();
    expect(meter.record(turn(9000))?.excessUsd).toBeUndefined();
  });

  it('never reports a negative excess', () => {
    const meter = createCacheMeter();
    meter.record(turn(9000, 0.2));
    meter.markCompaction();
    const verdict = meter.record(turn(1000, 0.01));
    expect(verdict?.excessCacheWrite).toBe(0);
    expect(verdict?.excessUsd).toBe(0);
  });

  it('reports the first compaction of a session without a baseline', () => {
    const meter = createCacheMeter();
    meter.markCompaction(12);
    const verdict = meter.record(turn(40_000));
    expect(verdict?.baselineTurns).toBe(0);
    expect(cacheLine(verdict!)).toContain('no baseline yet');
  });
});

describe('cacheLine', () => {
  it('puts the cost and what it bought on one line', () => {
    const meter = createCacheMeter();
    for (const usd of [0.05, 0.05, 0.05]) meter.record(turn(4000, usd));
    meter.markCompaction(21);
    const line = cacheLine(meter.record(turn(62_000, 0.46))!, meter.totals);
    expect(line).toBe(
      'cache rewritten 58k tokens above the 4000 baseline (+$0.41) for 21 context points freed',
    );
  });

  it('adds the session running total from the second compaction on', () => {
    const meter = createCacheMeter();
    meter.record(turn(4000, 0.05));
    meter.markCompaction(20);
    meter.record(turn(60_000, 0.45));
    meter.record(turn(4000, 0.05));
    meter.markCompaction(10);
    const line = cacheLine(meter.record(turn(50_000, 0.35))!, meter.totals);
    expect(line).toContain('session total');
    expect(line).toContain('over 2 compactions for 30 points');
  });
});

describe('turnSample', () => {
  it('reads the engine usage and derives one turn from the running ledger', () => {
    const sample = turnSample(
      {
        model: 'claude-opus-5',
        input_tokens: 12,
        output_tokens: 430,
        cache_read_input_tokens: 82_000,
        cache_creation_input_tokens: 61_500,
      },
      1.42,
      0.98,
    );
    expect(sample).toEqual({
      cacheWrite: 61_500,
      cacheRead: 82_000,
      input: 12,
      output: 430,
      usd: expect.closeTo(0.44, 5),
    });
  });

  it('has no sample for a turn the engine reported no usage for', () => {
    expect(turnSample(undefined, 1, 0.5)).toBeUndefined();
  });

  it('leaves usd out until there is a previous reading to subtract', () => {
    const sample = turnSample(
      {
        model: 'claude-opus-5',
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5,
      },
      1.42,
      undefined,
    );
    expect(sample?.usd).toBeUndefined();
  });
});
