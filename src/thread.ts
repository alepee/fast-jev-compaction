/**
 * The thread between tool calls.
 *
 * Judging a call one at a time is what the approach gets criticised for: on
 * its own, a failed `npm test` looks like dead weight, and dropping it is how
 * an assistant forgets what it already tried and walks back into the same
 * loop. The same call read next to its neighbours tells a different story.
 *
 * Two relations are recoverable locally, with no model and no request: a call
 * that retried a failed one, and a call whose target something later touched
 * again. Both are deterministic, both cost a handful of tokens, and both are
 * only attached to the calls that actually have them.
 */
import type { ToolCall } from './types.js';

/**
 * Fields whose value identifies what a call acted on, most specific first. A
 * tool that names none of them falls back to its whole input, so two calls
 * group only when they really are the same call.
 */
const TARGET_FIELDS = [
  'file_path',
  'filePath',
  'notebook_path',
  'path',
  'command',
  'url',
  'pattern',
  'query',
  'file',
] as const;

/** What a call acted on, as a comparable string. */
export function targetKey(input: Record<string, unknown>): string {
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ');
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/**
 * Fills in `retryOf` and `supersededBy` over a list of calls in transcript
 * order. A call retries the one before it on the same target when that one
 * failed; a call is superseded by the last call that came after it on the
 * same target, which is the freshest answer to the same question.
 *
 * Mutates and returns the calls, so a caller can pipe it after
 * `collectToolCalls`.
 */
export function linkCalls(calls: ToolCall[]): ToolCall[] {
  const groups = new Map<string, ToolCall[]>();
  for (const call of calls) {
    const key = `${call.tool}\u0000${targetKey(call.input)}`;
    const group = groups.get(key) ?? [];
    group.push(call);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const last = group[group.length - 1] as ToolCall;
    group.forEach((call, index) => {
      const previous = group[index - 1];
      if (previous?.isError) call.retryOf = previous.id;
      // Pointing at the last rather than the next: what makes an output stale
      // is the freshest answer to the same question, not the one after it.
      if (call !== last) call.supersededBy = last.id;
    });
  }
  return calls;
}

/** `Attempt after t12 failed. A later call (t80) ran the same tool on the same target.` */
export function threadNote(call: Pick<ToolCall, 'retryOf' | 'supersededBy'>): string {
  const parts: string[] = [];
  if (call.retryOf) parts.push(`This call came after ${call.retryOf} failed on the same target`);
  if (call.supersededBy) {
    parts.push(`${call.supersededBy} later ran the same tool on the same target`);
  }
  return parts.join('; ');
}
