import { describe, expect, it } from 'vitest';
import {
  collectToolCalls,
  estimateTokens,
  linkCalls,
  questionsFor,
  targetKey,
  threadNote,
  type Message,
  type ToolCall,
} from '../src/index.js';

function pair(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  output: string,
  isError = false,
): Message[] {
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }] },
  ];
}

function call(id: string, tool: string, input: Record<string, unknown>, isError = false): ToolCall {
  return {
    id,
    tool_use_id: id,
    tool,
    input,
    callIndex: Number(id.slice(1)),
    resultIndex: Number(id.slice(1)) + 1,
    resultChars: 10,
    isError,
    pinned: false,
  };
}

describe('targetKey', () => {
  it('prefers the most specific field naming what the call acted on', () => {
    expect(targetKey({ file_path: 'src/a.ts', limit: 20 })).toBe('src/a.ts');
    expect(targetKey({ command: 'npm   test' })).toBe('npm test');
    expect(targetKey({ url: 'https://x.dev' })).toBe('https://x.dev');
  });

  it('falls back to the whole input, so unrelated calls never group', () => {
    expect(targetKey({ a: 1 })).toBe('{"a":1}');
    expect(targetKey({ a: 1 })).not.toBe(targetKey({ a: 2 }));
  });

  it('ignores a field that is present but empty', () => {
    expect(targetKey({ file_path: '   ', command: 'ls' })).toBe('ls');
  });
});

describe('linkCalls', () => {
  it('leaves a call with no neighbour on its target alone', () => {
    const [a] = linkCalls([call('t1', 'Read', { file_path: 'a' })]);
    expect(a?.retryOf).toBeUndefined();
    expect(a?.supersededBy).toBeUndefined();
  });

  it('marks a call that followed a failure on the same target', () => {
    const calls = linkCalls([
      call('t1', 'Bash', { command: 'npm test' }, true),
      call('t2', 'Bash', { command: 'npm test' }),
    ]);
    expect(calls[1]?.retryOf).toBe('t1');
    expect(calls[0]?.retryOf).toBeUndefined();
  });

  it('does not call a rerun a retry when the first one succeeded', () => {
    const calls = linkCalls([
      call('t1', 'Bash', { command: 'npm test' }),
      call('t2', 'Bash', { command: 'npm test' }),
    ]);
    expect(calls[1]?.retryOf).toBeUndefined();
    expect(calls[0]?.supersededBy).toBe('t2');
  });

  it('points every earlier call at the freshest one, not at the next', () => {
    const calls = linkCalls([
      call('t1', 'Read', { file_path: 'a' }),
      call('t2', 'Read', { file_path: 'a' }),
      call('t3', 'Read', { file_path: 'a' }),
    ]);
    expect(calls.map((c) => c.supersededBy)).toEqual(['t3', 't3', undefined]);
  });

  it('keeps different tools and different targets apart', () => {
    const calls = linkCalls([
      call('t1', 'Read', { file_path: 'a' }),
      call('t2', 'Read', { file_path: 'b' }),
      call('t3', 'Grep', { file_path: 'a' }),
    ]);
    expect(calls.every((c) => !c.supersededBy && !c.retryOf)).toBe(true);
  });

  it('chains a retry of a retry', () => {
    const calls = linkCalls([
      call('t1', 'Bash', { command: 'make' }, true),
      call('t2', 'Bash', { command: 'make' }, true),
      call('t3', 'Bash', { command: 'make' }),
    ]);
    expect(calls.map((c) => c.retryOf)).toEqual([undefined, 't1', 't2']);
  });
});

describe('collectToolCalls', () => {
  it('links the calls it collects', () => {
    const messages = [
      ...pair('a', 'Bash', { command: 'npm test' }, 'FAIL', true),
      ...pair('b', 'Bash', { command: 'npm test' }, 'PASS'),
    ];
    const calls = collectToolCalls(messages, 0);
    expect(calls[1]?.retryOf).toBe('t1');
    expect(calls[0]?.supersededBy).toBe('t2');
  });
});

describe('threadNote', () => {
  it('says nothing about a call that stands alone', () => {
    expect(threadNote({})).toBe('');
  });

  it('names the failure it followed and the call that overtook it', () => {
    expect(threadNote({ retryOf: 't1' })).toBe('This call came after t1 failed on the same target');
    expect(threadNote({ retryOf: 't1', supersededBy: 't9' })).toBe(
      'This call came after t1 failed on the same target; t9 later ran the same tool on the same target',
    );
  });
});

describe('questionsFor', () => {
  const messages = [
    ...pair('a', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts', true),
    ...pair('b', 'Bash', { command: 'npm test' }, 'PASS'),
  ];

  it('tells Jev the failed attempt was retried, so it is not dead weight', () => {
    const calls = collectToolCalls(messages, 0);
    const questions = questionsFor(calls[1]!);
    expect(questions['call_t2']?.instructions).toContain('came after t1 failed');
    expect(questions['result_t2']?.instructions).toContain('came after t1 failed');
  });

  it('tells Jev an output was overtaken by a fresher one', () => {
    const calls = collectToolCalls(messages, 0);
    expect(questionsFor(calls[0]!)['result_t1']?.instructions).toContain(
      't2 later ran the same tool',
    );
  });

  it('adds nothing to a call that has no thread', () => {
    const [alone] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, 'y'), 0);
    const plain = questionsFor(alone!)['call_t1']!.instructions;
    expect(plain.endsWith('what the assistant does next')).toBe(true);
  });

  it('costs only a few tokens, and only where it applies', () => {
    const calls = collectToolCalls(messages, 0);
    const linked = estimateTokens(JSON.stringify(questionsFor(calls[1]!)));
    const alone = estimateTokens(
      JSON.stringify(questionsFor({ ...calls[1]!, retryOf: undefined, supersededBy: undefined })),
    );
    expect(linked - alone).toBeLessThan(40);
  });
});
