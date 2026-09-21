/**
 * The note left behind after a compaction.
 *
 * Pruning has a failure mode a summary does not. A summary announces itself:
 * the assistant reads "here is a summary" and knows the record is partial.
 * A pruned history announces nothing. It looks like the real transcript, and
 * in it the assistant finds its own past turns where work was reported and no
 * tool output backs it up. That is a strong in-context example of its own
 * behaviour, and it generalises from it: work can be declared done without
 * evidence. Observed in the wild by the OpenClaw port, not theorised.
 *
 * The fix is to make the pruning visible. One short note, once per compaction,
 * saying what was removed and that an absent output proves nothing.
 */
import type { CompactResult, Message } from './types.js';

/** Opens and closes the note, and is how the next compaction finds it again. */
export const GUARD_RAIL_TAG = 'keep-the-thread-notice';

const OPEN = `<${GUARD_RAIL_TAG}>`;
const CLOSE = `</${GUARD_RAIL_TAG}>`;

/** A message this plugin left on a previous compaction. */
export function isGuardRailMessage(message: Pick<Message, 'text'>): boolean {
  return message.text.trimStart().startsWith(OPEN);
}

/**
 * Removes the note left by the previous compaction. It is rewritten from the
 * new figures every time, so keeping the old one would only stack stale counts
 * and pay for them on every request.
 */
export function stripGuardRail<T extends Pick<Message, 'text'>>(
  messages: readonly T[],
): T[] {
  return messages.filter((message) => !isGuardRailMessage(message));
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** What the note says, given what this compaction actually did. */
export function guardRailText(stats: CompactResult['stats']): string {
  const removed = [
    stats.resultsDropped + stats.protected > 0
      ? `${plural(stats.resultsDropped + stats.protected, 'tool output')} shortened`
      : '',
    stats.callsDropped > 0 ? `${plural(stats.callsDropped, 'tool call')} removed` : '',
  ].filter(Boolean);
  return [
    OPEN,
    `This conversation was compacted: ${removed.join(' and ')}. Every message is`,
    'verbatim and complete; some tool outputs are not.',
    '',
    'A missing tool output is not evidence that the work behind it was done, and',
    'an earlier turn of yours that claims something without showing it is an',
    'artefact of this trimming, not a precedent. Before reporting anything in',
    'this history as finished, check the current state with a tool rather than',
    'trusting the trimmed record.',
    CLOSE,
  ].join('\n');
}

/**
 * Appends the note to a compacted transcript, and drops the one the previous
 * compaction left. Nothing is added when nothing was removed: a compaction
 * that only reordered has no gap to warn about.
 */
export function withGuardRail(
  messages: readonly Message[],
  stats: CompactResult['stats'],
): Message[] {
  const kept = stripGuardRail(messages);
  if (stats.resultsDropped + stats.callsDropped + stats.protected === 0) return kept;
  return [...kept, { role: 'user', text: guardRailText(stats), toolUses: [] }];
}
