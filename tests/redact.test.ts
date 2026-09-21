import { describe, expect, it } from 'vitest';
import { createRedactor, DEFAULT_RULES, noRedaction } from '../src/redact.js';

describe('redaction', () => {
  it('masks secrets, emails and account names in one pass', () => {
    const redact = createRedactor();
    const out = redact(
      'mail antoine@evaneos.com, key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA, file /Users/alepee/src/a.ts',
    );
    expect(out).not.toContain('antoine@evaneos.com');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).not.toContain('/Users/alepee/');
    expect(out).toContain('[email_1]');
    expect(out).toContain('[token_1]');
    // The path itself is signal the assistant needs; only the account goes.
    expect(out).toContain('/Users/[user_1]/src/a.ts');
  });

  it('gives the same value the same placeholder everywhere', () => {
    const redact = createRedactor();
    const first = redact('from a@b.com to c@d.com');
    const second = redact('again a@b.com');
    expect(first).toBe('from [email_1] to [email_2]');
    expect(second).toBe('again [email_1]');
    expect(redact.counts).toEqual({ email: 2 });
    expect(redact.size).toBe(2);
  });

  it('keeps the key name and masks only the value', () => {
    const out = createRedactor()('ANTHROPIC_API_KEY="abcdefghijklmnop" in .env');
    expect(out).toBe('ANTHROPIC_API_KEY="[secret_1]" in .env');
  });

  it('masks credentials in a URL without losing the host', () => {
    const out = createRedactor()('git clone https://alepee:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/x/y.git');
    expect(out).toContain('github.com/x/y.git');
    expect(out).not.toContain('alepee:');
  });

  it('only masks card numbers that pass Luhn', () => {
    const redact = createRedactor();
    expect(redact('card 4242 4242 4242 4242')).toBe('card [card_1]');
    // A plausible-looking id that is not a card stays: false positives cost signal.
    expect(redact('id 1234 5678 9012 3456')).toBe('id 1234 5678 9012 3456');
  });

  it('leaves phones and public IPs alone until strict', () => {
    expect(createRedactor()('call +33 6 12 34 56 78 at 51.15.20.3')).toContain('+33 6 12 34 56 78');
    const strict = createRedactor({ level: 'strict' });
    const out = strict('call +33 6 12 34 56 78 at 51.15.20.3 (lan 192.168.1.4)');
    expect(out).toContain('[phone_1]');
    expect(out).toContain('[ip_1]');
    // A private address says nothing about anyone.
    expect(out).toContain('192.168.1.4');
  });

  it('takes extra rules and can be turned off entirely', () => {
    const redact = createRedactor({
      extraRules: [{ name: 'ticket', pattern: /\bEVA-\d+\b/g }],
    });
    expect(redact('see EVA-1234')).toBe('see [ticket_1]');
    expect(noRedaction()('antoine@evaneos.com')).toBe('antoine@evaneos.com');
    expect(createRedactor({ level: 'off' })('antoine@evaneos.com')).toBe('antoine@evaneos.com');
  });

  it('has no rule that matches an empty string', () => {
    for (const rule of DEFAULT_RULES) {
      expect(new RegExp(rule.pattern.source).test('')).toBe(false);
    }
  });
});

describe('redaction in the Jev state', () => {
  it('masks message text, tool inputs and the derived goal, and says so in the context', async () => {
    const { compact, fitState, collectToolCalls, STATE_CONTEXT } = await import('../src/index.js');
    const messages = [
      { role: 'user' as const, text: 'deploy for antoine@evaneos.com', toolUses: [] },
      {
        role: 'assistant' as const,
        text: '',
        toolUses: [
          {
            tool_use_id: 'a',
            tool: 'Bash',
            input: { command: 'curl -H "authorization: Bearer sk-live-AAAAAAAAAAAAAAAAAAAA" x' },
          },
        ],
      },
      { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok' }] },
    ];
    const redactor = createRedactor();
    const { state } = fitState(messages, collectToolCalls(messages, 0), {
      goal: '',
      maxStateTokens: 25_000,
      preserveRecentMessages: 0,
    }, redactor);
    const json = JSON.stringify(state);
    expect(json).not.toContain('antoine@evaneos.com');
    expect(json).not.toContain('sk-live-AAAA');
    expect(state.context).not.toBe(STATE_CONTEXT);
    expect(state.context).toContain('masked');

    // What comes back out is still the untouched original.
    const result = await compact(
      messages,
      { judge: async () => ({ answers: { call_t1: { noul: 0.9 }, result_t1: { noul: 0.9 } } }) },
      { preserveRecentMessages: 0 },
    );
    expect(result.messages[0]?.text).toBe('deploy for antoine@evaneos.com');
    expect(result.stats.redactions).toMatchObject({ email: 1 });
  });

  it('leaves the state alone when redaction is off', async () => {
    const { fitState, collectToolCalls, STATE_CONTEXT } = await import('../src/index.js');
    const messages = [{ role: 'user' as const, text: 'ping antoine@evaneos.com', toolUses: [] }];
    const { state } = fitState(messages, collectToolCalls(messages, 0), {
      goal: '',
      maxStateTokens: 25_000,
      preserveRecentMessages: 0,
    }, createRedactor({ level: 'off' }));
    expect(JSON.stringify(state)).toContain('antoine@evaneos.com');
    expect(state.context).toBe(STATE_CONTEXT);
  });
});
