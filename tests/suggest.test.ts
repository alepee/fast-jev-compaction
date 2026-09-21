import { describe, expect, it } from 'vitest';
import {
  initialAutoCompactState,
  resolveHookConfig,
  shouldAutoCompact,
  shouldSuggest,
  suggestionLine,
  type AutoCompactState,
  type HookConfig,
} from '../hooks/keep-the-thread.ts';

const config: HookConfig = resolveHookConfig({});
const ready = (over: Partial<AutoCompactState> = {}): AutoCompactState => ({
  ...initialAutoCompactState(config),
  ...over,
});

describe('onBoundary', () => {
  it('notifies by default, and compacts only when asked to', () => {
    expect(config.onBoundary).toBe('notify');
    expect(resolveHookConfig({ onBoundary: 'compact' }).onBoundary).toBe('compact');
    expect(resolveHookConfig({ onBoundary: 'nonsense' }).onBoundary).toBe('notify');
  });
});

describe('shouldAutoCompact', () => {
  it('asks for a judgment once the trigger is reached', () => {
    expect(shouldAutoCompact(ready(), 65, config)).toEqual({ compact: false, ask: true });
  });

  it('gives the adviser a cooldown of its own, since notifying resets nothing', () => {
    expect(shouldAutoCompact(ready({ turnsSinceAdvice: 1 }), 65, config)).toEqual({
      compact: false,
    });
    expect(shouldAutoCompact(ready({ turnsSinceAdvice: 3 }), 65, config)).toEqual({
      compact: false,
      ask: true,
    });
  });

  it('still compacts on its own past the ceiling, whatever the mode', () => {
    // Waiting there would hand the turn to the built-in summary instead.
    expect(shouldAutoCompact(ready({ turnsSinceAdvice: 0 }), 90, config)).toEqual({
      compact: true,
    });
  });

  it('needs no judgment when the adviser is off', () => {
    const noAdvice = resolveHookConfig({ advise: false });
    expect(shouldAutoCompact(ready({ turnsSinceAdvice: 0 }), 65, noAdvice)).toEqual({
      compact: true,
    });
  });
});

describe('shouldSuggest', () => {
  it('says it once', () => {
    expect(shouldSuggest(ready(), 65, config)).toBe(true);
  });

  it('holds its tongue until the context has really grown', () => {
    const said = ready({ suggestedAtPercent: 65 });
    expect(shouldSuggest(said, 66, config)).toBe(false);
    expect(shouldSuggest(said, 69, config)).toBe(false);
    expect(shouldSuggest(said, 70, config)).toBe(true);
  });
});

describe('suggestionLine', () => {
  it('says what to do, not just that something is up', () => {
    expect(suggestionLine(66.4)).toBe('a good moment to compact (66% context): /compact');
  });
});
