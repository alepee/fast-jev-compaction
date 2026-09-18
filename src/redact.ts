/**
 * Redaction of the state sent to Jev.
 *
 * The compacted transcript is always verbatim: redaction applies only to the
 * copy of the conversation that leaves the machine. Nothing is ever restored,
 * so this is one-way masking, not reversible pseudonymisation.
 *
 * Each distinct value gets a stable placeholder (`[email_1]`), so Jev still
 * sees that two mentions are the same thing without seeing what it is.
 */

export type RedactionLevel = 'off' | 'standard' | 'strict';

export interface RedactionRule {
  /** Placeholder family, e.g. `email` gives `[email_1]`. */
  name: string;
  pattern: RegExp;
  /** Only the value is masked; the rest of the match is kept. Default: whole match. */
  group?: number;
  /** `strict` rules are off by default: they trade false positives for coverage. */
  level?: RedactionLevel;
  /** Extra check on the matched value; a false result leaves the text alone. */
  accept?: (value: string) => boolean;
}

const PRIVATE_IP =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|255\.)/;

function luhn(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = clean.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Ordered: the most specific rule wins, because an earlier replacement leaves a
 * placeholder the later patterns no longer match.
 */
export const DEFAULT_RULES: readonly RedactionRule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    name: 'token',
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{40,}|shpat_[a-f0-9]{30,})\b/g,
  },
  {
    name: 'token',
    pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{16,}=*)/g,
    group: 1,
  },
  {
    name: 'url_credentials',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+:[^/\s:@]+)@/g,
    group: 2,
  },
  {
    // The key name is kept: `api_key=[secret_1]` still tells Jev what it was.
    name: 'secret',
    pattern:
      /[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|pwd|auth[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9!#$%&*+/=?^_`{|}~.-]{12,})/gi,
    group: 1,
  },
  {
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    name: 'iban',
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g,
  },
  {
    name: 'card',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: luhn,
  },
  {
    // The path itself is signal the assistant needs; only the account name goes.
    name: 'user',
    pattern: /((?:\/Users\/|\/home\/|C:\\Users\\))([^/\\\s"':,);]+)/g,
    group: 2,
  },
  {
    name: 'phone',
    pattern: /(?<![\w.-])\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){2,5}\d{2,4}(?![\w.-])/g,
    level: 'strict',
  },
  {
    name: 'ip',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    level: 'strict',
    accept: (value) => !PRIVATE_IP.test(value),
  },
];

export interface Redactor {
  /** Masks a string; returns it unchanged when redaction is off. */
  (text: string): string;
  /** How many distinct values were masked, per rule name. */
  readonly counts: Readonly<Record<string, number>>;
  /** Total distinct values masked. */
  readonly size: number;
}

export interface RedactorOptions {
  level?: RedactionLevel;
  /** Appended to the built-in rules, so a project can mask its own shapes. */
  extraRules?: readonly RedactionRule[];
  /**
   * Literal values to mask wherever they appear, whatever their shape. This is
   * how a detector that returns values rather than patterns plugs in, such as
   * the gitleaks scan in `gitleaks.ts`. Matched before everything else.
   */
  literals?: readonly string[];
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Literal values as rules, longest first so a value never gets half-masked by
 * a shorter one it contains.
 */
export function literalRules(literals: readonly string[]): RedactionRule[] {
  const sorted = [...new Set(literals.filter((value) => value.trim().length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  return sorted.map((value) => ({
    name: 'secret',
    pattern: new RegExp(escapeLiteral(value), 'g'),
  }));
}

/** A no-op redactor, for `level: 'off'` and for tests. */
export function noRedaction(): Redactor {
  const identity = ((text: string) => text) as Redactor;
  return Object.defineProperties(identity, {
    counts: { value: Object.freeze({}), enumerable: true },
    size: { value: 0, enumerable: true },
  }) as Redactor;
}

/**
 * Builds a redactor whose placeholders are stable for the whole compaction:
 * the same value always gets the same label, across messages and requests.
 */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const level = options.level ?? 'standard';
  if (level === 'off') return noRedaction();
  const rules = [
    ...literalRules(options.literals ?? []),
    ...DEFAULT_RULES,
    ...(options.extraRules ?? []),
  ].filter((rule) => (rule.level ?? 'standard') === 'standard' || level === 'strict');
  const labels = new Map<string, string>();
  const counts: Record<string, number> = {};

  const label = (name: string, value: string): string => {
    const key = `${name}:${value}`;
    const known = labels.get(key);
    if (known) return known;
    counts[name] = (counts[name] ?? 0) + 1;
    const placeholder = `[${name}_${counts[name]}]`;
    labels.set(key, placeholder);
    return placeholder;
  };

  const redact = ((text: string): string => {
    if (!text) return text;
    let out = text;
    for (const rule of rules) {
      const group = rule.group ?? 0;
      out = out.replace(rule.pattern, (...args: unknown[]) => {
        const match = args[0] as string;
        const value = (group === 0 ? match : (args[group] as string | undefined)) ?? '';
        if (!value || (rule.accept && !rule.accept(value))) return match;
        const placeholder = label(rule.name, value);
        return group === 0 ? placeholder : match.replace(value, placeholder);
      });
    }
    return out;
  }) as Redactor;

  return Object.defineProperties(redact, {
    counts: { get: () => ({ ...counts }), enumerable: true },
    size: { get: () => labels.size, enumerable: true },
  }) as Redactor;
}
