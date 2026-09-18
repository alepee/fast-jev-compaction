import { describe, expect, it } from 'vitest';
import {
  decideCall,
  droppableRatio,
  isSideEffectTool,
  resolveOptions,
  type Message,
  type ToolCall,
} from '../src/index.js';

const unpinned: Pick<ToolCall, 'id' | 'tool' | 'pinned'> = {
  id: 't1',
  tool: 'Read',
  pinned: false,
};

describe('asymmetric thresholds', () => {
  it('needs far more doubt to delete a call than to truncate a result', () => {
    // 0.3 is under the result threshold but over the call one: recoverable step only.
    expect(decideCall(unpinned, { keepCall: 0.3, keepResult: 0.3 }).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.5, keepResult: 0.5 }).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.1 }).action).toBe('drop_call');
  });

  it('never deletes the call of a tool that changed something', () => {
    for (const tool of ['Bash', 'Write', 'Edit', 'Task', 'mcp__linear__save_issue']) {
      const decision = decideCall({ ...unpinned, tool }, { keepCall: 0, keepResult: 0 });
      expect(decision.action, tool).toBe('drop_result');
      expect(decision.reason, tool).toBe('protected');
    }
    expect(decideCall({ ...unpinned, tool: 'Read' }, { keepCall: 0, keepResult: 0 }).action).toBe(
      'drop_call',
    );
  });

  it('never deletes the call that produced an error, unless told to', () => {
    const failed = { ...unpinned, isError: true };
    expect(decideCall(failed, { keepCall: 0, keepResult: 0 }).reason).toBe('protected');
    expect(
      decideCall(failed, { keepCall: 0, keepResult: 0 }, { protectErrors: false }).reason,
    ).toBe('call_dropped');
  });

  it('takes a custom side-effect list', () => {
    expect(isSideEffectTool('Deploy')).toBe(false);
    expect(isSideEffectTool('Deploy', ['Deploy'])).toBe(true);
    // An MCP tool is a black box: always treated as one.
    expect(isSideEffectTool('mcp__x__y', [])).toBe(true);
    expect(
      decideCall({ ...unpinned, tool: 'Deploy' }, { keepCall: 0, keepResult: 0 }, {
        sideEffectTools: ['Deploy'],
      }).reason,
    ).toBe('protected');
  });

  it('still honours a single keepThreshold for callers that set one', () => {
    const options = { keepThreshold: 0.5 };
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe('drop_call');
  });

  it('keeps the thresholds within the finite range', () => {
    expect(resolveOptions({ keepCallThreshold: Number.NaN }).keepCallThreshold).toBe(0.15);
  });
});

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

describe('droppableRatio', () => {
  it('reports the best case a compaction could reach, without a request', () => {
    const big = 'x'.repeat(4000);
    const messages: Message[] = [
      message('user', 'go'),
      message('assistant', '', {
        toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: 'a.ts' } }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 'a', text: big }] }),
      message('assistant', 'done'),
    ];
    const ratio = droppableRatio(messages, { preserveRecentMessages: 0, truncateHeadChars: 300 });
    expect(ratio).toBeGreaterThan(0.9);
    // Everything pinned means nothing to gain: the caller can skip Jev entirely.
    expect(droppableRatio(messages, { preserveRecentMessages: 6 })).toBe(0);
    expect(droppableRatio([])).toBe(0);
  });
});
