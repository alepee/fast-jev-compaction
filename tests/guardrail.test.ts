import { describe, expect, it } from 'vitest';
import {
  GUARD_RAIL_TAG,
  guardRailText,
  isGuardRailMessage,
  stripGuardRail,
  withGuardRail,
  type CompactResult,
  type Message,
} from '../src/index.js';

function stats(over: Partial<CompactResult['stats']> = {}): CompactResult['stats'] {
  return {
    messagesBefore: 10,
    messagesAfter: 10,
    charsBefore: 1000,
    charsAfter: 400,
    calls: 3,
    kept: 1,
    resultsDropped: 0,
    callsDropped: 0,
    protected: 0,
    pinned: 0,
    redactions: {},
    stateTokens: 100,
    stateStage: 'full',
    requests: 1,
    ms: 1,
    ...over,
  };
}

const conversation: Message[] = [
  { role: 'user', text: 'fix the test', toolUses: [] },
  { role: 'assistant', text: 'done', toolUses: [] },
];

describe('guardRailText', () => {
  it('says what was removed, in the plural it deserves', () => {
    expect(guardRailText(stats({ resultsDropped: 1 }))).toContain('1 tool output shortened');
    expect(guardRailText(stats({ resultsDropped: 12 }))).toContain('12 tool outputs shortened');
    expect(guardRailText(stats({ resultsDropped: 3, callsDropped: 1 }))).toContain(
      '3 tool outputs shortened and 1 tool call removed',
    );
  });

  it('counts a protected call as shortened, because that is what happened to it', () => {
    expect(guardRailText(stats({ resultsDropped: 2, protected: 1 }))).toContain(
      '3 tool outputs shortened',
    );
  });

  it('names the trap it exists for', () => {
    const text = guardRailText(stats({ resultsDropped: 1 }));
    expect(text).toContain('not evidence that the work behind it was done');
    expect(text).toContain('check the current state with a tool');
    expect(text).toContain('Every message is\nverbatim and complete');
  });

  it('is wrapped in the tag the next compaction looks for', () => {
    const text = guardRailText(stats({ resultsDropped: 1 }));
    expect(text.startsWith(`<${GUARD_RAIL_TAG}>`)).toBe(true);
    expect(text.trimEnd().endsWith(`</${GUARD_RAIL_TAG}>`)).toBe(true);
  });
});

describe('isGuardRailMessage', () => {
  it('recognises its own note and nothing else', () => {
    expect(isGuardRailMessage({ text: guardRailText(stats({ resultsDropped: 1 })) })).toBe(true);
    expect(isGuardRailMessage({ text: `  <${GUARD_RAIL_TAG}>\nx` })).toBe(true);
    expect(isGuardRailMessage({ text: 'fix the test' })).toBe(false);
    expect(isGuardRailMessage({ text: `talking about <${GUARD_RAIL_TAG}>` })).toBe(false);
  });
});

describe('withGuardRail', () => {
  it('adds nothing when the compaction removed nothing', () => {
    expect(withGuardRail(conversation, stats())).toEqual(conversation);
  });

  it('appends one note at the end when something was removed', () => {
    const out = withGuardRail(conversation, stats({ resultsDropped: 4 }));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(conversation[0]);
    expect(out[2]?.role).toBe('user');
    expect(isGuardRailMessage(out[2]!)).toBe(true);
  });

  it('replaces the previous note instead of stacking stale counts', () => {
    const once = withGuardRail(conversation, stats({ resultsDropped: 4 }));
    const twice = withGuardRail(once, stats({ resultsDropped: 9 }));
    expect(twice.filter(isGuardRailMessage)).toHaveLength(1);
    expect(twice[2]?.text).toContain('9 tool outputs');
    expect(twice[2]?.text).not.toContain('4 tool outputs');
  });

  it('drops a stale note even when this compaction adds none', () => {
    const once = withGuardRail(conversation, stats({ resultsDropped: 4 }));
    expect(withGuardRail(once, stats())).toEqual(conversation);
  });

  it('carries no tool calls, so it can never become a candidate', () => {
    const out = withGuardRail(conversation, stats({ callsDropped: 1 }));
    expect(out[2]?.toolUses).toEqual([]);
    expect(out[2]?.toolResults).toBeUndefined();
  });
});

describe('stripGuardRail', () => {
  it('leaves a conversation that never had one alone', () => {
    expect(stripGuardRail(conversation)).toEqual(conversation);
  });
});

describe('the log line', () => {
  it('counts the compaction, not the notice it appended', async () => {
    const { compactSession, resolveHookConfig } = await import('../hooks/keep-the-thread.ts');
    const config = { ...resolveHookConfig({ preserveRecentMessages: 0 }), apiKey: 'k' };
    const messages = [
      { role: 'user' as const, text: 'go', toolUses: [] },
      {
        role: 'assistant' as const,
        text: '',
        toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'x' } }],
      },
      {
        role: 'user' as const,
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'a', text: 'y'.repeat(3000) }],
      },
      { role: 'user' as const, text: 'next', toolUses: [] },
    ];
    const fetchFn = async () => ({
      status: 200,
      ok: true,
      text: JSON.stringify({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0.01 } } }),
    });
    const { result, messages: out } = await compactSession(messages, config, fetchFn);
    expect(out).toHaveLength(messages.length + 1);
    expect(isGuardRailMessage(out[out.length - 1]!)).toBe(true);
    // What the log reports: the compaction's own figures, notice excluded.
    expect(result.stats.messagesAfter).toBe(messages.length);
    expect(result.stats.messagesBefore).toBe(messages.length);
  });
});
