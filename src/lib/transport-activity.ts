/**
 * The Log entry for a notable BMP request. A request is notable when it
 * failed, needed a retry, waited in the queue, ran long, or moved a large
 * payload. Only a failure is a problem: the user lost a result. A slow, large
 * or retried request that still answered is a diagnostic (shown under All).
 * The command class stays in the detail; the row says what happened.
 */
import type { ActivityEntry, ActivityMeta } from './types';
import type { BmpTransportOutcome } from './bmp-transport';

export interface TransportActivity {
  level: ActivityEntry['level'];
  message: string;
  detail: string;
  meta: ActivityMeta;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "9×IntegrationGetObjectCommand" → { count: 9, name: "IntegrationGetObjectCommand" }. */
function parseOperation(operation: string, commandCount: number): { count: number; name: string | null } {
  const m = /^(?:(\d+)×)?([A-Za-z]+)$/.exec(operation);
  if (!m) return { count: commandCount || 1, name: null };
  return { count: m[1] ? Number(m[1]) : (commandCount || 1), name: m[2] };
}

/** Sentences for an operation summary such as "9×IntegrationGetObjectCommand". */
export function operationPhrases(operation: string, commandCount = 1): { done: string; failed: string } {
  const { count, name } = parseOperation(operation, commandCount);
  return phrases(name, count);
}

function phrases(name: string | null, count: number): { done: string; failed: string } {
  switch (name) {
    case 'IntegrationGetObjectCommand':
      return { done: `Read ${plural(count, 'object')}`, failed: `Could not read ${plural(count, 'object')}` };
    case 'GetPropertiesByIdCommand':
      return { done: `Read properties of ${plural(count, 'object')}`, failed: `Could not read properties of ${plural(count, 'object')}` };
    case 'ExtendedExecuteCommand':
      return count > 1
        ? { done: `Ran ${count} EC queries`, failed: `${count} EC queries failed` }
        : { done: 'Ran an EC query', failed: 'An EC query failed' };
    default:
      return count > 1
        ? { done: `Sent ${count} server commands`, failed: `${count} server commands failed` }
        : { done: 'Sent a server command', failed: 'A server command failed' };
  }
}

/** Slow, queued or large: worth a diagnostic line. */
export function isNotableOutcome(outcome: BmpTransportOutcome): boolean {
  if (!outcome.ok) return outcome.error.kind !== 'cancelled';
  return outcome.attempts > 1
    || outcome.durationMs >= 10_000
    || outcome.queueWaitMs >= 2_000
    || outcome.requestBytes >= 256 * 1024
    || outcome.responseBytes >= 1024 * 1024;
}

/** The Log entry for a notable outcome, or null for an ordinary one. */
export function transportActivity(outcome: BmpTransportOutcome): TransportActivity | null {
  if (!isNotableOutcome(outcome)) return null;
  const { count, name } = parseOperation(outcome.operation ?? '', outcome.commandCount ?? 1);
  const words = phrases(name, count);
  const notes: string[] = [];
  if (outcome.ok) {
    if (outcome.attempts > 1) notes.push(`answered after ${outcome.attempts} attempts`);
    if (outcome.queueWaitMs >= 2_000) notes.push(`waited ${(outcome.queueWaitMs / 1000).toFixed(1)} s in the queue`);
  }
  const detail = [
    ...(!outcome.ok ? [outcome.error.message] : []),
    `${outcome.feature ? `${outcome.feature} · ` : ''}${outcome.operation}`,
    `${bytes(outcome.responseBytes)} answer, ${bytes(outcome.requestBytes)} request`,
    `run ${outcome.durationMs} ms, queue ${outcome.queueWaitMs} ms (depth ${outcome.queueDepth})`,
    plural(outcome.attempts, 'attempt'),
  ].join('\n');
  return {
    level: outcome.ok ? 'info' : 'error',
    message: outcome.ok
      ? `${words.done}${notes.length ? `, ${notes.join(', ')}` : ''}`
      : `${words.failed} (${outcome.error.kind})`,
    detail,
    meta: { category: 'system', action: 'server-request', durationMs: outcome.durationMs },
  };
}
