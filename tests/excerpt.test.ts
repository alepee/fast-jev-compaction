import { describe, expect, it } from 'vitest';
import {
  clipMiddle,
  collectToolCalls,
  createRedactor,
  estimateTokens,
  maskKept,
  questionsFor,
  redactionCorpus,
  REDACTION_MARGIN,
  resolveOptions,
  type Message,
} from '../src/index.js';

function pair(id: string, tool: string, input: Record<string, unknown>, output: string, isError = false): Message[] {
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: output, isError }] },
  ];
}

const long = 'ERR_CONNECTION_REFUSED at db.ts:44\n'.repeat(60);

describe('clipMiddle', () => {
  it('leaves a short text alone and says how much it took out of a long one', () => {
    expect(clipMiddle('short', 100)).toBe('short');
    const clipped = clipMiddle('x'.repeat(500), 100);
    expect(clipped.length).toBeLessThanOrEqual(100);
    expect(clipped).toContain('omitted');
  });
});

describe('collectToolCalls with excerpts', () => {
  it('carries no excerpt unless one was asked for', () => {
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, long), 0);
    expect(call?.resultExcerpt).toBeUndefined();
  });

  it('keeps a wide slice, so masking later cannot push a secret past the cut', () => {
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, long), 0, 200);
    expect(call?.resultExcerpt?.length).toBeLessThanOrEqual(200 + REDACTION_MARGIN);
    expect(call?.resultExcerpt?.length).toBeGreaterThan(200);
  });

  it('has nothing to excerpt from an empty result', () => {
    const [call] = collectToolCalls(pair('a', 'Bash', { command: 'true' }, ''), 0, 200);
    expect(call?.resultExcerpt).toBeUndefined();
  });
});

describe('questionsFor', () => {
  it('asks about the result without its content by default', () => {
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, long), 0, 200);
    const question = questionsFor(call!)['result_t1']!;
    expect(question.instructions).not.toContain('ERR_CONNECTION_REFUSED');
    expect(question.instructions).toContain('2100 chars');
  });

  it('shows the content once an excerpt is asked for', () => {
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, long), 0, 200);
    const question = questionsFor(call!, { excerptChars: 200 })['result_t1']!;
    expect(question.instructions).toContain('It reads:');
    expect(question.instructions).toContain('ERR_CONNECTION_REFUSED');
  });

  it('says a failed call failed rather than that it reads', () => {
    const [call] = collectToolCalls(pair('a', 'Bash', { command: 'npm test' }, 'boom '.repeat(200), true), 0, 200);
    const question = questionsFor(call!, { excerptChars: 200 })['result_t1']!;
    expect(question.instructions).toContain('It failed:');
  });

  it('masks the excerpt before it leaves', () => {
    const secret = 'contact ops@evaneos.com about it\n'.repeat(40);
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, secret), 0, 200);
    const redact = createRedactor({ level: 'standard' });
    const question = questionsFor(call!, { excerptChars: 200, redact })['result_t1']!;
    expect(question.instructions).not.toContain('ops@evaneos.com');
    expect(question.instructions).toContain('[email_1]');
  });

  it('leaves the call question untouched: the excerpt is paid once, not twice', () => {
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, long), 0, 200);
    const with_ = questionsFor(call!, { excerptChars: 200 })['call_t1']!;
    const without = questionsFor(call!)['call_t1']!;
    expect(with_.instructions).toBe(without.instructions);
  });

  it('stays within a predictable budget per call', () => {
    const [call] = collectToolCalls(pair('a', 'Read', { file_path: 'x' }, long), 0, 200);
    const plain = estimateTokens(JSON.stringify(questionsFor(call!)));
    const rich = estimateTokens(JSON.stringify(questionsFor(call!, { excerptChars: 200 })));
    expect(rich - plain).toBeLessThan(90);
  });
});

describe('redactionCorpus', () => {
  const messages = pair('a', 'Read', { file_path: 'x' }, 'AKIAIOSFODNN7EXAMPLE in the output');

  it('leaves results out when nothing will be excerpted', () => {
    expect(redactionCorpus(messages)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('scans exactly the window the questions will excerpt', () => {
    expect(redactionCorpus(messages, 200)).toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('never feeds gitleaks more of a result than will be sent', () => {
    const huge = pair('a', 'Read', { file_path: 'x' }, 'y'.repeat(50_000));
    expect(redactionCorpus(huge, 200).length).toBeLessThan(200 + REDACTION_MARGIN + 200);
  });
});

describe('maskKept', () => {
  it('masks before the final clip', () => {
    const redact = createRedactor({ level: 'standard' });
    const text = `${'a'.repeat(190)}ops@evaneos.com${'b'.repeat(400)}`;
    const kept = maskKept(text, 200, redact);
    expect(kept).not.toContain('ops@evaneos.com');
    expect(kept.length).toBeLessThanOrEqual(200);
  });
});

describe('resolveOptions', () => {
  it('excerpts 200 characters by default and takes 0 as off', () => {
    expect(resolveOptions().resultExcerptChars).toBe(200);
    expect(resolveOptions({ resultExcerptChars: 0 }).resultExcerptChars).toBe(0);
    expect(resolveOptions({ resultExcerptChars: -5 }).resultExcerptChars).toBe(0);
  });
});
