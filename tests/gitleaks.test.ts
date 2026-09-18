import { describe, expect, it, vi } from 'vitest';
import {
  createRedactor,
  parseGitleaksReport,
  redactionCorpus,
  scanForSecrets,
  secretsFromFindings,
  type Message,
  type ProcessRunner,
} from '../src/index.js';
import { withScannedSecrets } from '../hooks/fast-jev.ts';

const transcript: Message[] = [
  { role: 'user', text: 'use the staging key', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      {
        tool_use_id: 'a',
        tool: 'Bash',
        input: { command: 'DEPLOY=zK9wQ2mNbV7xLp4TcRfY curl x' },
      },
    ],
  },
  {
    role: 'user',
    text: '',
    toolUses: [],
    toolResults: [{ tool_use_id: 'a', text: 'never leaves the machine' }],
  },
];

function report(secrets: string[]): string {
  return JSON.stringify(
    secrets.map((Secret) => ({ RuleID: 'generic-api-key', Secret, Match: `k=${Secret}` })),
  );
}

describe('gitleaks scan', () => {
  it('only scans what will actually be sent', () => {
    const corpus = redactionCorpus(transcript);
    expect(corpus).toContain('use the staging key');
    expect(corpus).toContain('zK9wQ2mNbV7xLp4TcRfY');
    // Tool results are replaced by a note before the state leaves, so they are
    // not worth the scan time.
    expect(corpus).not.toContain('never leaves the machine');
  });

  it('feeds the transcript on stdin and asks for a JSON report on stdout', async () => {
    const run = vi.fn<ProcessRunner>(async () => ({
      exitCode: 0,
      stdout: report(['zK9wQ2mNbV7xLp4TcRfY']),
      stderr: '',
    }));
    const scan = await scanForSecrets(transcript, run, { config: '/tmp/.gitleaks.toml' });
    expect(scan.secrets).toEqual(['zK9wQ2mNbV7xLp4TcRfY']);
    const [argv, init] = run.mock.calls[0]!;
    expect(argv).toEqual([
      'gitleaks',
      'stdin',
      '--report-format',
      'json',
      '--report-path',
      '-',
      '--no-banner',
      '--log-level',
      'error',
      '--exit-code',
      '0',
      '--config',
      '/tmp/.gitleaks.toml',
    ]);
    expect(init?.stdin).toContain('zK9wQ2mNbV7xLp4TcRfY');
    // --redact would hand back a masked value, which we could not then find.
    expect(argv).not.toContain('--redact');
  });

  it('keeps the built-in rules working when the binary is missing', async () => {
    const run: ProcessRunner = async () => {
      throw new Error('spawn gitleaks ENOENT');
    };
    const scan = await scanForSecrets(transcript, run);
    expect(scan.secrets).toEqual([]);
    expect(scan.skipped).toContain('ENOENT');
  });

  it('reports a failed run instead of pretending the transcript is clean', async () => {
    const run: ProcessRunner = async () => ({ exitCode: 2, stdout: '', stderr: 'bad config' });
    expect((await scanForSecrets(transcript, run)).skipped).toContain('bad config');
  });

  it('survives a report that is not the JSON we expect', () => {
    expect(parseGitleaksReport('')).toEqual([]);
    expect(parseGitleaksReport('not json')).toEqual([]);
    expect(parseGitleaksReport('{"a":1}')).toEqual([]);
    // gitleaks may print a line before the array.
    expect(parseGitleaksReport('warn: x\n[{"Secret":"abcdefghij"}]')).toHaveLength(1);
  });

  it('drops values too short to be worth masking, longest first', () => {
    const secrets = secretsFromFindings(
      [{ Secret: 'short' }, { Secret: 'abcdefghij' }, { Secret: 'abcdefghijklmnop' }, { Match: 'm'.repeat(9) }],
      8,
    );
    expect(secrets).toEqual(['abcdefghijklmnop', 'abcdefghij', 'mmmmmmmmm']);
  });

  it('masks a found secret that no built-in pattern would catch', () => {
    const plain = createRedactor();
    expect(plain('DEPLOY=zK9wQ2mNbV7xLp4TcRfY')).toContain('zK9wQ2mNbV7xLp4TcRfY');
    const armed = createRedactor({ literals: ['zK9wQ2mNbV7xLp4TcRfY'] });
    expect(armed('DEPLOY=zK9wQ2mNbV7xLp4TcRfY twice zK9wQ2mNbV7xLp4TcRfY')).toBe(
      'DEPLOY=[secret_1] twice [secret_1]',
    );
  });

  it('never half-masks a secret that contains another', () => {
    const redact = createRedactor({ literals: ['abcdefghij', 'abcdefghijklmnop'] });
    expect(redact('abcdefghijklmnop')).toBe('[secret_1]');
  });

  it('treats a literal as text, not as a pattern', () => {
    const redact = createRedactor({ literals: ['a.c(d)+[e]'] });
    expect(redact('key=a.c(d)+[e] and abcdefghij')).toBe('key=[secret_1] and abcdefghij');
  });
});

describe('gitleaks in the hook', () => {
  const base = { gitleaks: true, compactAtPercent: 60, minReductionRatio: 0.25, cooldownTurns: 3, minPercentDrop: 5, maxAutoCompactions: 8, model: 'jev-latest' };

  it('adds the found secrets to the literals the redactor masks', async () => {
    const run: ProcessRunner = async () => ({ exitCode: 0, stdout: report(['zK9wQ2mNbV7xLp4TcRfY']), stderr: '' });
    const { config, note } = await withScannedSecrets(transcript, base, run);
    expect(config.redactLiterals).toEqual(['zK9wQ2mNbV7xLp4TcRfY']);
    expect(note).toBe('gitleaks masked 1 secret(s)');
  });

  it('does nothing when it is off or the host has no process access', async () => {
    const run: ProcessRunner = async () => ({ exitCode: 0, stdout: report(['zK9wQ2mNbV7xLp4TcRfY']), stderr: '' });
    expect((await withScannedSecrets(transcript, { ...base, gitleaks: false }, run)).config.redactLiterals)
      .toBeUndefined();
    expect((await withScannedSecrets(transcript, base, undefined)).config.redactLiterals).toBeUndefined();
  });
});
