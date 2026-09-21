import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
  TurnUsage,
} from 'claude-code';

import {
  cacheLine,
  createCacheMeter,
  type CacheMeter,
  type TurnSample,
} from '../src/cachemeter.js';
import { compact, droppableRatio, reductionRatio, resolveOptions } from '../src/compact.js';
import { stripGuardRail, withGuardRail } from '../src/guardrail.js';
import { adviseCompaction, type Advice, type AdviserOptions } from '../src/adviser.js';
import { scanForSecrets, type GitleaksOptions, type ProcessRunner } from '../src/gitleaks.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  Judge,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  /** Turns to let pass after a compaction before auto-compacting again. */
  cooldownTurns: 3,
  /**
   * Context points a compaction must win back for auto-compaction to stay at
   * the same trigger. Below it, the trigger is raised above the level that did
   * not pay off, so the next attempt only comes when the context has really
   * grown. This is what stops a session from compacting every single turn.
   */
  minPercentDrop: 5,
  /** Hard stop on auto-compactions in one session. */
  maxAutoCompactions: 8,
  /**
   * Context percent above which the context is compacted without asking Jev
   * whether the moment is right. Past this the window is about to fill
   * anyway, so a bad moment costs less than running out of room, and a session
   * never stops compacting because the adviser is unreachable.
   */
  alwaysCompactAtPercent: 85,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  /**
   * Scan the state with gitleaks before sending it. On by default and skipped
   * when the binary is not installed; set it to false to never try.
   */
  gitleaks: boolean;
  gitleaksBinary?: string;
  gitleaksConfig?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  cooldownTurns: number;
  minPercentDrop: number;
  maxAutoCompactions: number;
  /** Ask Jev whether the session is at a boundary before auto-compacting. */
  advise: boolean;
  /**
   * What happens once the moment is judged right: `notify` says so on the
   * notification bar and pins a line under the prompt, leaving the call to
   * the person; `compact` does it. Either way the ceiling still compacts on
   * its own, because past it the built-in summary would take over instead.
   */
  onBoundary: 'notify' | 'compact';
  /**
   * Leave a note after a compaction saying what was removed and that a missing
   * tool output proves nothing. A pruned history looks like a complete one,
   * and an assistant reading its own unbacked turns learns from them.
   */
  guardRail: boolean;
  /**
   * Report what each compaction costs in rewritten prompt cache. Free: the
   * figures come from the turn usage and the cost ledger the engine already
   * holds, and nothing is sent anywhere.
   */
  measureCache: boolean;
  alwaysCompactAtPercent: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Record<string, number> = {};
  for (const key of [
    'keepThreshold',
    'keepResultThreshold',
    'keepCallThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
    'resultExcerptChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...(numbers as Partial<CompactOptions>),
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    cooldownTurns: Math.max(
      0,
      optionNumber(options, 'cooldownTurns', HOOK_DEFAULTS.cooldownTurns),
    ),
    minPercentDrop: Math.max(
      0,
      optionNumber(options, 'minPercentDrop', HOOK_DEFAULTS.minPercentDrop),
    ),
    maxAutoCompactions: Math.max(
      0,
      optionNumber(options, 'maxAutoCompactions', HOOK_DEFAULTS.maxAutoCompactions),
    ),
    gitleaks: options['gitleaks'] !== false,
    advise: options['advise'] !== false,
    onBoundary: options['onBoundary'] === 'compact' ? 'compact' : 'notify',
    guardRail: options['guardRail'] !== false,
    measureCache: options['measureCache'] !== false,
    alwaysCompactAtPercent: optionNumber(
      options,
      'alwaysCompactAtPercent',
      HOOK_DEFAULTS.alwaysCompactAtPercent,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const gitleaksBinary = optionString(options, 'gitleaksBinary');
  if (gitleaksBinary) config.gitleaksBinary = gitleaksBinary;
  const gitleaksConfig = optionString(options, 'gitleaksConfig');
  if (gitleaksConfig) config.gitleaksConfig = gitleaksConfig;
  const redact = optionString(options, 'redact');
  if (redact === 'off' || redact === 'standard' || redact === 'strict') config.redact = redact;
  const sideEffectTools = optionString(options, 'sideEffectTools');
  if (sideEffectTools) {
    config.sideEffectTools = sideEffectTools
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (typeof options['protectErrors'] === 'boolean') {
    config.protectErrors = options['protectErrors'];
  }
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `Judge` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): Judge {
  return {
    async judge(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/**
 * Remembers, for the session, that the binary is not there. A missing gitleaks
 * will not appear between two compactions, so asking again every time would
 * only cost a failed spawn and repeat the same line in the log.
 */
export interface GitleaksState {
  available?: boolean;
  warned?: boolean;
}

/**
 * Asks gitleaks for the secrets in what is about to be sent, so the redactor
 * can mask values no pattern of ours would recognise. Enabled by default and
 * never required: with no binary installed the built-in rules still run, the
 * reason is logged once, and later compactions do not try again.
 */
export async function withScannedSecrets(
  messages: readonly SessionMessage[],
  config: HookConfig,
  run: ProcessRunner | undefined,
  state: GitleaksState = {},
): Promise<{ config: HookConfig; note?: string }> {
  if (!config.gitleaks || !run || state.available === false) return { config };
  const options: GitleaksOptions = {
    // Whatever the questions will excerpt has to be scanned with the rest.
    excerptChars: resolveOptions(config).resultExcerptChars,
  };
  if (config.gitleaksBinary) options.binary = config.gitleaksBinary;
  if (config.gitleaksConfig) options.config = config.gitleaksConfig;
  const scan = await scanForSecrets(messages, run, options);
  if (scan.unavailable) {
    state.available = false;
    // Said once, then never again for this session.
    if (state.warned) return { config };
    state.warned = true;
    return { config, note: scan.skipped };
  }
  state.available = true;
  if (scan.skipped) return { config, note: scan.skipped };
  if (scan.secrets.length === 0) return { config };
  return {
    config: {
      ...config,
      redactLiterals: [...(config.redactLiterals ?? []), ...scan.secrets],
    },
    note: `gitleaks masked ${scan.secrets.length} secret(s)`,
  };
}

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  // The previous compaction's note is dropped before Jev ever sees it: it is
  // rewritten from this run's figures, and stale counts are worse than none.
  const input = config.guardRail ? stripGuardRail(messages) : [...messages];
  const result = await compact(input, jevAsker(fetchFn, config.apiKey, config.model), config);
  const output = config.guardRail ? withGuardRail(result.messages, result.stats) : result.messages;
  return { result, messages: toSessionMessages(input, output) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** `3 email, 1 secret`, or '' when nothing was masked. */
export function redactionSummary(result: CompactResult): string {
  return Object.entries(result.stats.redactions)
    .map(([name, n]) => `${n} ${name}`)
    .join(', ');
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const masked = redactionSummary(result);
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.protected > 0 ? `${stats.protected} protected` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)${
    masked ? `; masked ${masked}` : ''
  }`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

/**
 * Turns the engine's report of a finished turn into a meter sample. `usd` is
 * the session ledger's own delta rather than a price table, so nothing here
 * goes stale when rates change; it is left out until there is a previous
 * reading to subtract.
 */
export function turnSample(
  usage: TurnUsage | undefined,
  totalUsd: number | undefined,
  previousTotalUsd: number | undefined,
): TurnSample | undefined {
  if (!usage) return undefined;
  const sample: TurnSample = {
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
  if (
    typeof totalUsd === 'number' &&
    typeof previousTotalUsd === 'number' &&
    totalUsd >= previousTotalUsd
  ) {
    sample.usd = totalUsd - previousTotalUsd;
  }
  return sample;
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

/**
 * Everything that keeps auto-compaction from firing turn after turn. Held per
 * session in the closure: a cooldown, a trigger that climbs when a compaction
 * did not win context back, and a hard cap.
 */
export interface AutoCompactState {
  turnsSinceCompaction: number;
  /**
   * Turns since the adviser was last consulted. It costs a request, and in
   * notify mode nothing happens to reset the compaction cooldown, so without
   * this the question would be asked again every single turn.
   */
  turnsSinceAdvice: number;
  compactions: number;
  /** Trigger in force, raised above a context level that did not pay off. */
  trigger: number;
  /** Context percent right after the last compaction, or undefined. */
  lastPercentAfter?: number;
  /** Context percent at which a compaction was last suggested to the person. */
  suggestedAtPercent?: number;
  /** Set once the guards give up on this session. */
  disabledReason?: string;
}

export function initialAutoCompactState(config: HookConfig): AutoCompactState {
  return {
    turnsSinceCompaction: Number.POSITIVE_INFINITY,
    turnsSinceAdvice: Number.POSITIVE_INFINITY,
    compactions: 0,
    trigger: config.compactAtPercent,
  };
}

/**
 * `ask` means the cheap guards passed and the decision now needs a judgment:
 * the caller asks Jev whether the session is at a boundary. Keeping it out of
 * this function is what keeps the guards pure and testable.
 */
export type AutoCompactVerdict =
  | { compact: true; ask?: false }
  | { compact: false; ask: true }
  | { compact: false; ask?: false; reason?: string };

/** Decides whether this turn should ask for a compaction. Pure, so it is testable. */
export function shouldAutoCompact(
  state: AutoCompactState,
  percent: number,
  config: HookConfig,
): AutoCompactVerdict {
  if (state.disabledReason) return { compact: false };
  if (state.compactions >= config.maxAutoCompactions) {
    return {
      compact: false,
      reason: `auto-compaction off for this session (${config.maxAutoCompactions} compactions already)`,
    };
  }
  if (state.turnsSinceCompaction < config.cooldownTurns) return { compact: false };
  if (percent < state.trigger) return { compact: false };
  // Past the ceiling the window is about to fill anyway: compact without
  // spending a request on whether the moment is ideal.
  if (percent >= config.alwaysCompactAtPercent) return { compact: true };
  if (!config.advise) return { compact: true };
  // The judgment costs a request. In notify mode nothing resets the
  // compaction cooldown, so the adviser needs a cooldown of its own.
  if (state.turnsSinceAdvice < config.cooldownTurns) return { compact: false };
  return { compact: false, ask: true };
}

/**
 * Whether the person should be told again. The pinned line stays up on its
 * own, so a second notice is only worth it once the context has grown past
 * where the last one was raised.
 */
export function shouldSuggest(
  state: AutoCompactState,
  percent: number,
  config: HookConfig,
): boolean {
  return (
    state.suggestedAtPercent === undefined ||
    percent >= state.suggestedAtPercent + config.minPercentDrop
  );
}

/** `a good moment to compact (66% context): /compact`, for the bar and the pinned line. */
export function suggestionLine(percent: number): string {
  return `a good moment to compact (${Math.round(percent)}% context): /compact`;
}

/** The adviser settings a hook config implies; the snapshot reuses the compaction's masking. */
export function adviserOptions(config: HookConfig): AdviserOptions {
  return config.redact ? { redact: config.redact } : {};
}

/** `boundary reached: score 0.72 vs floor 0.66 (finished 0.91, hands-on 0.78)`, for the log. */
export function adviceLine(advice: Advice): string {
  if (advice.error) return `no judgment, nothing suggested (${advice.error})`;
  return `${advice.compact ? 'boundary reached' : 'mid-task, nothing suggested'}: score ${advice.score.toFixed(
    2,
  )} vs floor ${advice.floor.toFixed(2)} (finished ${advice.finished.toFixed(
    2,
  )}, hands-on ${advice.handsOn.toFixed(2)})`;
}

/**
 * Records what a compaction actually won back. A compaction that did not free
 * `minPercentDrop` points pushes the trigger above where the context now sits,
 * so the next one waits for real growth instead of firing on the next turn.
 */
export function noteCompaction(
  state: AutoCompactState,
  percentBefore: number,
  percentAfter: number,
  config: HookConfig,
): AutoCompactState {
  const next: AutoCompactState = {
    ...state,
    compactions: state.compactions + 1,
    turnsSinceCompaction: 0,
    lastPercentAfter: percentAfter,
  };
  if (percentBefore - percentAfter < config.minPercentDrop) {
    next.trigger = Math.min(95, Math.max(state.trigger, percentAfter + config.minPercentDrop));
    if (next.trigger >= 95) {
      next.disabledReason = 'compaction stopped freeing context';
    }
  }
  return next;
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let auto = initialAutoCompactState(configured);
  const gitleaks: GitleaksState = {};
  const cache: CacheMeter = createCacheMeter();
  /** Session cost at the end of the previous turn, to derive one turn's cost. */
  let lastTotalUsd: number | undefined;
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    // Every compaction rewrites the cached prefix, the built-in summary
    // included, so the meter is armed before we know which path this takes.
    if (configured.measureCache) cache.markCompaction();
    // Whoever compacted, the standing suggestion is spent.
    if (auto.suggestedAtPercent !== undefined) {
      $.ui.status(undefined);
      auto = { ...auto, suggestedAtPercent: undefined };
    }
    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      // Local, free, and no request: if even a perfect run could not reach the
      // minimum, fall back now instead of paying Jev to tell us so.
      const ceiling = droppableRatio(event.messages, config);
      if (ceiling < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (at most ${percent(ceiling)} removable, below the ${percent(
            config.minReductionRatio,
          )} minimum; Jev not called)`,
        );
        return next(event);
      }
      // Wrapped rather than passed: the engine's nouns are only ever called
      // in place, never handed around as values.
      const scanned = await withScannedSecrets(
        event.messages,
        config,
        (argv, init) => $.process.run(argv, init),
        gitleaks,
      );
      if (scanned.note) $.ui.log(scanned.note);
      const { result, messages } = await compactSession(event.messages, scanned.config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      notify(
        $,
        // The compaction's own figures: `messages` also carries the notice the
        // guard rail appends, and counting it here read as though compacting
        // had created a message.
        `kept ${result.stats.messagesAfter}/${result.stats.messagesBefore} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    auto = {
      ...auto,
      turnsSinceCompaction: auto.turnsSinceCompaction + 1,
      turnsSinceAdvice: auto.turnsSinceAdvice + 1,
    };
    try {
      const usage = await $.session.usage();
      const before = usage.context.percent ?? 0;
      if (configured.measureCache) {
        const sample = turnSample(event.usage, usage.cost?.usd, lastTotalUsd);
        lastTotalUsd = usage.cost?.usd ?? lastTotalUsd;
        const cost = sample ? cache.record(sample) : undefined;
        if (cost) $.ui.log(cacheLine(cost, cache.totals));
      }
      const verdict = shouldAutoCompact(auto, before, configured);
      if (!verdict.compact) {
        if (verdict.ask) {
          // The guards passed; only the moment is still in question.
          const config = { ...configured, apiKey: await getApiKey($, configured) };
          const advice = await adviseCompaction(
            await $.session.messages(),
            before / 100,
            jevAsker(
              async (url, init) => {
                const response = await $.http.fetch(url, init);
                return { status: response.status, ok: response.ok, text: response.text };
              },
              config.apiKey ?? '',
              config.model,
            ),
            adviserOptions(config),
          );
          auto = { ...auto, turnsSinceAdvice: 0 };
          $.ui.log(adviceLine(advice));
          if (!advice.compact) {
            // The moment passed, or never came: a pinned line saying otherwise
            // would be stale from here on.
            if (auto.suggestedAtPercent !== undefined) {
              $.ui.status(undefined);
              auto = { ...auto, suggestedAtPercent: undefined };
            }
            return next(event);
          }
        } else {
          if (verdict.reason) $.ui.log(verdict.reason);
          return next(event);
        }
      }
      // The moment is right. Whose call it is depends on `onBoundary`, except
      // past the ceiling, where waiting would hand the turn to the built-in
      // summary instead.
      if (configured.onBoundary === 'notify' && before < configured.alwaysCompactAtPercent) {
        const line = suggestionLine(before);
        // The pinned line is the standing signal; the bar is only for the
        // moment it changes, and only when there is something new to say.
        $.ui.status(line);
        if (shouldSuggest(auto, before, configured)) $.ui.toast(line, { timeoutMs: 15_000 });
        auto = { ...auto, suggestedAtPercent: before };
        return next(event);
      }
      compacting = true;
      await $.session.compact();
      const after = (await $.session.usage()).context.percent ?? before;
      // Re-arms with what this compaction won back, so the next turn's cache
      // rewrite is reported against the points it bought.
      if (configured.measureCache) cache.markCompaction(before - after);
      const previous = auto;
      auto = noteCompaction(auto, before, after, configured);
      if (auto.trigger !== previous.trigger) {
        $.ui.log(
          `auto-compaction trigger raised to ${auto.trigger}% (${before}% → ${after}%, under the ${configured.minPercentDrop}-point minimum)`,
        );
      }
      if (auto.disabledReason && !previous.disabledReason) {
        notify($, `auto-compaction disabled for this session: ${auto.disabledReason}`);
      }
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
