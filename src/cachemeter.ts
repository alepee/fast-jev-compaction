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
 *
 * The excess alone is not actionable, because the two sides of the trade are
 * not the same kind of thing: the rewrite is paid once, the smaller prompt is
 * saved on every later turn. So the meter converts them into the one number
 * that compares them, the turns it takes for the saving to repay the rewrite.
 */

/**
 * What a cache write and a cache read cost relative to a base input token.
 * Only their ratio matters here, and it is what makes the break-even long:
 * writing is dearer than base input, reading is far cheaper, so a rewrite
 * takes many turns of a smaller prompt to earn back.
 */
export const CACHE_WRITE_RATE = 1.25;
export const CACHE_READ_RATE = 0.1;

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
  /**
   * Prompt tokens a normal turn carried before the compaction, and after it.
   * Read plus written: what the request actually costs, whatever the mix.
   */
  baselinePrompt: number;
  prompt: number;
  /** Prompt tokens no longer sent on every later turn. Negative when it grew. */
  freedTokens: number;
  /**
   * Turns of the smaller prompt needed to repay the rewrite. Absent when the
   * compaction freed nothing, in which case it never repays.
   */
  breakEvenTurns?: number;
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
  /** Overrides the assumed cache write rate, for a host that prices differently. */
  writeRate?: number;
  /** Overrides the assumed cache read rate. */
  readRate?: number;
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

/** What one turn actually sends: the cached part it reads plus the part it writes. */
export function promptTokens(sample: Pick<TurnSample, 'cacheRead' | 'cacheWrite'>): number {
  return sample.cacheRead + sample.cacheWrite;
}

/**
 * Turns of a prompt shorter by `freedTokens` needed to repay rewriting
 * `excessCacheWrite`. Undefined when the compaction freed nothing, because
 * then there is nothing to repay it with.
 */
export function breakEvenTurns(
  excessCacheWrite: number,
  freedTokens: number,
  writeRate = CACHE_WRITE_RATE,
  readRate = CACHE_READ_RATE,
): number | undefined {
  if (freedTokens <= 0 || excessCacheWrite <= 0 || readRate <= 0) return undefined;
  return Math.ceil((excessCacheWrite * writeRate) / (freedTokens * readRate));
}

function definedUsd(samples: readonly TurnSample[]): number[] {
  return samples
    .map((sample) => sample.usd)
    .filter((usd): usd is number => typeof usd === 'number' && Number.isFinite(usd));
}

export function createCacheMeter(options: CacheMeterOptions = {}): CacheMeter {
  const window = Math.max(1, Math.floor(options.baselineTurns ?? 5));
  const writeRate = options.writeRate ?? CACHE_WRITE_RATE;
  const readRate = options.readRate ?? CACHE_READ_RATE;
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
      const baselinePrompt = median(recent.map(promptTokens));
      const prompt = promptTokens(sample);
      const usdSamples = definedUsd(recent);
      const excessCacheWrite = Math.max(0, sample.cacheWrite - baselineCacheWrite);
      // Measured, not reported: the prompt shrank by whatever the request
      // stopped carrying, which no caller has to tell us.
      const freedTokens = baselinePrompt - prompt;
      const verdict: CacheVerdict = {
        baselineTurns: recent.length,
        baselineCacheWrite,
        cacheWrite: sample.cacheWrite,
        excessCacheWrite,
        baselinePrompt,
        prompt,
        freedTokens,
      };
      const turns = breakEvenTurns(excessCacheWrite, freedTokens, writeRate, readRate);
      if (turns !== undefined) verdict.breakEvenTurns = turns;
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
 * `cache rewritten 214k tokens above the 16k baseline, 39k less to send each
 * turn: ~69 turns to break even`, or a line saying why it never will.
 *
 * The break-even is the point of the line. The excess on its own reads as a
 * cost with nothing to weigh it against, and the context freed reads as a win
 * with nothing to weigh it against either.
 */
export function cacheLine(verdict: CacheVerdict, totals?: CacheTotals): string {
  if (verdict.baselineTurns === 0) {
    return `cache write ${thousands(verdict.cacheWrite)} tokens after compaction (no baseline yet)`;
  }
  let line = `cache rewritten ${thousands(verdict.excessCacheWrite)} tokens above the ${thousands(
    verdict.baselineCacheWrite,
  )} baseline`;
  if (verdict.excessUsd !== undefined) line += ` (+${dollars(verdict.excessUsd)})`;
  if (verdict.freedTokens > 0) {
    line += `, ${thousands(verdict.freedTokens)} less to send each turn`;
  }
  if (verdict.pointsFreed !== undefined) line += ` (${verdict.pointsFreed} context points)`;
  line +=
    verdict.breakEvenTurns !== undefined
      ? `: ~${verdict.breakEvenTurns} turns to break even`
      : ': it never breaks even, the prompt did not get smaller';
  if (!totals || totals.compactions <= 1) return line;
  const running = `session total ${thousands(totals.excessCacheWrite)} tokens${
    totals.excessUsd !== undefined ? ` (${dollars(totals.excessUsd)})` : ''
  } rewritten over ${totals.compactions} compactions`;
  return `${line}; ${running}`;
}
