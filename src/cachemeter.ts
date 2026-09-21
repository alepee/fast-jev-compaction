/**
 * What a compaction costs in prompt cache.
 *
 * Editing the history invalidates the cached prefix from the first changed
 * message on, so the next request rewrites the cache for everything after it.
 * The context meter never shows that: it reports the window filling up, not
 * the tokens paid to refill the cache. A compaction can therefore look like a
 * clear win (points freed) while costing more than it saved.
 *
 * This meter puts the two on the same line. It compares the turn right after
 * a compaction with the turns before it, and attributes the excess to the
 * compaction. Baselines are medians rather than means, so a single heavy turn
 * does not hide the rewrite behind it.
 */

/** One turn's usage, as `turn.complete` reports it, plus what it cost. */
export interface TurnSample {
  cacheWrite: number;
  cacheRead: number;
  input: number;
  output: number;
  /** Dollars this turn added to the session ledger; absent where the host keeps none. */
  usd?: number;
}

/** What one compaction cost, measured on the turn that followed it. */
export interface CacheVerdict {
  /** Turns the baseline was taken over; 0 means there was nothing to compare to. */
  baselineTurns: number;
  baselineCacheWrite: number;
  cacheWrite: number;
  /** Cache tokens rewritten beyond what a normal turn writes. Never negative. */
  excessCacheWrite: number;
  baselineUsd?: number;
  usd?: number;
  excessUsd?: number;
  /** Context points the compaction won back, when the caller knows them. */
  pointsFreed?: number;
}

export interface CacheTotals {
  compactions: number;
  excessCacheWrite: number;
  excessUsd?: number;
  pointsFreed: number;
}

export interface CacheMeterOptions {
  /** Turns the baseline is taken over. Default 5. */
  baselineTurns?: number;
}

export interface CacheMeter {
  /**
   * Files one finished turn. Returns the verdict when this turn is the one
   * that followed a compaction, and nothing otherwise.
   */
  record(sample: TurnSample): CacheVerdict | undefined;
  /** Says a compaction just happened, so the next turn is the one to measure. */
  markCompaction(pointsFreed?: number): void;
  readonly totals: CacheTotals;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function definedUsd(samples: readonly TurnSample[]): number[] {
  return samples
    .map((sample) => sample.usd)
    .filter((usd): usd is number => typeof usd === 'number' && Number.isFinite(usd));
}

export function createCacheMeter(options: CacheMeterOptions = {}): CacheMeter {
  const window = Math.max(1, Math.floor(options.baselineTurns ?? 5));
  const recent: TurnSample[] = [];
  const totals: CacheTotals = { compactions: 0, excessCacheWrite: 0, pointsFreed: 0 };
  let pending: { pointsFreed?: number } | undefined;

  return {
    totals,
    markCompaction(pointsFreed) {
      pending = pointsFreed === undefined ? {} : { pointsFreed };
    },
    record(sample) {
      if (!pending) {
        recent.push(sample);
        if (recent.length > window) recent.shift();
        return undefined;
      }
      const { pointsFreed } = pending;
      pending = undefined;
      const baselineCacheWrite = median(recent.map((s) => s.cacheWrite));
      const usdSamples = definedUsd(recent);
      const verdict: CacheVerdict = {
        baselineTurns: recent.length,
        baselineCacheWrite,
        cacheWrite: sample.cacheWrite,
        excessCacheWrite: Math.max(0, sample.cacheWrite - baselineCacheWrite),
      };
      if (pointsFreed !== undefined) verdict.pointsFreed = pointsFreed;
      if (typeof sample.usd === 'number' && usdSamples.length > 0) {
        const baselineUsd = median(usdSamples);
        verdict.baselineUsd = baselineUsd;
        verdict.usd = sample.usd;
        verdict.excessUsd = Math.max(0, sample.usd - baselineUsd);
      }
      totals.compactions += 1;
      totals.excessCacheWrite += verdict.excessCacheWrite;
      if (pointsFreed !== undefined) totals.pointsFreed += pointsFreed;
      if (verdict.excessUsd !== undefined) {
        totals.excessUsd = (totals.excessUsd ?? 0) + verdict.excessUsd;
      }
      // The rewrite turn is not a normal turn: it would poison the next baseline.
      return verdict;
    },
  };
}

function thousands(tokens: number): string {
  return tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : `${Math.round(tokens)}`;
}

function dollars(usd: number): string {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * `cache rewritten 58k tokens above the 4k baseline (+$0.41) for 21 context
 * points freed`, or a line saying the baseline was missing.
 */
export function cacheLine(verdict: CacheVerdict, totals?: CacheTotals): string {
  if (verdict.baselineTurns === 0) {
    return `cache write ${thousands(verdict.cacheWrite)} tokens after compaction (no baseline yet)`;
  }
  const parts = [
    `cache rewritten ${thousands(verdict.excessCacheWrite)} tokens above the ${thousands(
      verdict.baselineCacheWrite,
    )} baseline`,
  ];
  if (verdict.excessUsd !== undefined) parts.push(`+${dollars(verdict.excessUsd)}`);
  if (verdict.pointsFreed !== undefined) parts.push(`for ${verdict.pointsFreed} context points freed`);
  const line = `${parts[0]}${verdict.excessUsd !== undefined ? ` (${parts[1]})` : ''}${
    verdict.pointsFreed !== undefined ? ` ${parts[parts.length - 1]}` : ''
  }`;
  if (!totals || totals.compactions <= 1) return line;
  const running = `session total ${thousands(totals.excessCacheWrite)} tokens${
    totals.excessUsd !== undefined ? ` (${dollars(totals.excessUsd)})` : ''
  } over ${totals.compactions} compactions for ${totals.pointsFreed} points`;
  return `${line}; ${running}`;
}
