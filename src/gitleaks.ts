/**
 * Secret detection through the gitleaks binary.
 *
 * Presidio and other NER-based detectors were the other candidate; they cost a
 * Python runtime and a several-hundred-megabyte model load, which a compaction
 * on the hot path cannot pay. gitleaks is one static binary with hundreds of
 * maintained rules, reads stdin and writes JSON, so it runs in well under a
 * second on a whole transcript.
 *
 * It finds secrets, not people: emails, IBANs, cards and account names stay
 * with the built-in rules in `redact.ts`. What it returns here is a list of
 * literal values, which the redactor masks like any other rule.
 *
 * Nothing leaves the machine: the binary is local, and the secrets it reports
 * are only ever used to remove themselves from the state.
 */
import type { Message } from './types.js';

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The shape of the host's `$.process.run`, so this is testable without one. */
export type ProcessRunner = (
  argv: readonly string[],
  init?: { stdin?: string; timeoutMs?: number; cwd?: string },
) => Promise<ProcessRunResult>;

/** One gitleaks finding, as its JSON report names the fields. */
export interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  Match?: string;
  Secret?: string;
  Entropy?: number;
}

export interface GitleaksOptions {
  /** Binary to run. Default `gitleaks`, resolved on PATH. */
  binary?: string;
  /** A `.gitleaks.toml` to use instead of the default rules. */
  config?: string;
  /** Give up after this long and keep the built-in rules only. Default 10s. */
  timeoutMs?: number;
  /**
   * Shorter values are ignored. A three-character "secret" is noise, and
   * masking it would eat text Jev needs. Default 8.
   */
  minLength?: number;
  cwd?: string;
}

export interface GitleaksScan {
  /** Distinct literal values to mask, longest first. */
  secrets: string[];
  findings: GitleaksFinding[];
  /** Why no scan happened, when `secrets` is empty for a reason worth logging. */
  skipped?: string;
}

const EMPTY: GitleaksScan = { secrets: [], findings: [] };

/**
 * The text that will actually be sent to Jev: message text and tool inputs.
 * Tool results never leave (they are replaced by a `ok, N chars` note), so
 * scanning them would only cost time.
 */
export function redactionCorpus(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.text) parts.push(message.text);
    for (const tool of message.toolUses) {
      try {
        parts.push(JSON.stringify(tool.input));
      } catch {
        // An input that will not serialise never reaches the state either.
      }
    }
  }
  return parts.join('\n');
}

/** Parses a gitleaks JSON report; an empty or malformed one yields nothing. */
export function parseGitleaksReport(stdout: string): GitleaksFinding[] {
  const text = stdout.trim();
  if (!text) return [];
  const start = text.indexOf('[');
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? (parsed as GitleaksFinding[]) : [];
}

/** The literal values worth masking, longest first so a match wins over its substring. */
export function secretsFromFindings(
  findings: readonly GitleaksFinding[],
  minLength: number,
): string[] {
  const values = new Set<string>();
  for (const finding of findings) {
    const value = (finding.Secret || finding.Match || '').trim();
    if (value.length >= minLength) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Scans a transcript for secrets. Never throws: a missing binary, a timeout or
 * an unreadable report leaves the built-in rules to do what they can, and says
 * so in `skipped`.
 */
export async function scanForSecrets(
  messages: readonly Message[],
  run: ProcessRunner,
  options: GitleaksOptions = {},
): Promise<GitleaksScan> {
  const corpus = redactionCorpus(messages);
  if (!corpus.trim()) return EMPTY;
  const argv = [
    options.binary ?? 'gitleaks',
    'stdin',
    '--report-format',
    'json',
    '--report-path',
    '-',
    '--no-banner',
    '--log-level',
    'error',
    // Findings are the normal case here, not a failure.
    '--exit-code',
    '0',
  ];
  // Never `--redact`: the report has to carry the real value for us to remove it.
  if (options.config) argv.push('--config', options.config);
  let result: ProcessRunResult;
  try {
    result = await run(argv, {
      stdin: corpus,
      timeoutMs: options.timeoutMs ?? 10_000,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (error) {
    return {
      ...EMPTY,
      skipped: `gitleaks unavailable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  const findings = parseGitleaksReport(result.stdout);
  if (findings.length === 0 && result.exitCode !== 0) {
    return { ...EMPTY, skipped: `gitleaks failed (${result.stderr.trim().slice(0, 200)})` };
  }
  return { secrets: secretsFromFindings(findings, options.minLength ?? 8), findings };
}
