// Semantic diff of a policy's statements for the review.
// Statements have no IDs. They are matched by position first (same place, same
// content), then by content (Moved), then by position again (Changed). What is
// left is Added or Removed. Nothing here writes to the saved policy.
import { PBAC_ACTIONS, pbacActions, pbacEffect, DENY_IGNORED } from './pbac-syntax';
import { statementSummary, statementSentence, subjectChips } from './statement-model';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
const keyOf = value => JSON.stringify(stable(value));
const copy = value => JSON.parse(JSON.stringify(value));
const list = value => Array.isArray(value) ? value : value === undefined ? [] : [value];

/** Pairs that keep their relative order (longest increasing run of after-indices). */
function inPlace(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]), tails = [], previous = new Array(sorted.length);
  sorted.forEach(([, j], k) => {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >> 1; if (sorted[tails[mid]][1] < j) low = mid + 1; else high = mid; }
    previous[k] = low ? tails[low - 1] : -1;
    tails[low] = k;
  });
  const kept = new Set();
  for (let k = tails.at(-1) ?? -1; k >= 0; k = previous[k]) kept.add(sorted[k][0]);
  return kept;
}

export function diffStatements(before = [], after = []) {
  const keysBefore = before.map(keyOf), keysAfter = after.map(keyOf);
  const usedBefore = new Set(), usedAfter = new Set(), pairs = [];
  const pair = (i, j) => { usedBefore.add(i); usedAfter.add(j); pairs.push([i, j]); };
  // 1. Same place, same content. 2. Same content elsewhere.
  for (let i = 0; i < Math.min(before.length, after.length); i++) if (keysBefore[i] === keysAfter[i]) pair(i, i);
  for (let j = 0; j < after.length; j++) {
    if (usedAfter.has(j)) continue;
    const i = keysBefore.findIndex((key, index) => !usedBefore.has(index) && key === keysAfter[j]);
    if (i >= 0) pair(i, j);
  }
  // 3. What is left is paired by position among the leftovers: an edited statement.
  const restBefore = before.map((_, i) => i).filter(i => !usedBefore.has(i));
  const restAfter = after.map((_, j) => j).filter(j => !usedAfter.has(j));
  for (let k = 0; k < Math.min(restBefore.length, restAfter.length); k++) pair(restBefore[k], restAfter[k]);
  const kept = inPlace(pairs), changes = [];
  for (const [i, j] of pairs) {
    const same = keysBefore[i] === keysAfter[j], moved = !kept.has(i);
    if (same && !moved) continue;
    changes.push({ type: same ? 'moved' : 'changed', moved, beforeIndex: i, afterIndex: j, before: before[i], after: after[j],
      parts: same ? [] : statementParts(before[i], after[j]) });
  }
  for (let j = 0; j < after.length; j++)
    if (!usedAfter.has(j)) changes.push({ type: 'added', beforeIndex: -1, afterIndex: j, before: undefined, after: after[j], parts: [] });
  for (let i = 0; i < before.length; i++)
    if (!usedBefore.has(i)) changes.push({ type: 'removed', beforeIndex: i, afterIndex: -1, before: before[i], after: undefined, parts: [] });
  const position = c => c.afterIndex >= 0 ? c.afterIndex : c.beforeIndex - 0.5;
  return changes.sort((a, b) => position(a) - position(b));
}

/** What differs inside one statement. */
export function statementParts(before = {}, after = {}) {
  const parts = [];
  const effectBefore = pbacEffect(before.Effect) ?? before.Effect, effectAfter = pbacEffect(after.Effect) ?? after.Effect;
  if (effectBefore !== effectAfter) parts.push({ field: 'effect', before: effectBefore, after: effectAfter });
  const a = new Set(before.Action === '*' ? PBAC_ACTIONS : pbacActions(before.Action));
  const b = new Set(after.Action === '*' ? PBAC_ACTIONS : pbacActions(after.Action));
  const added = PBAC_ACTIONS.filter(x => b.has(x) && !a.has(x)), removed = PBAC_ACTIONS.filter(x => a.has(x) && !b.has(x));
  if (added.length || removed.length) parts.push({ field: 'actions', added, removed, kept: PBAC_ACTIONS.filter(x => a.has(x) && b.has(x)) });
  else if (keyOf(before.Action) !== keyOf(after.Action)) parts.push({ field: 'action-tokens' });
  const sa = list(before.Subject).map(String), sb = list(after.Subject).map(String);
  const subjectsAdded = sb.filter(x => !sa.includes(x)), subjectsRemoved = sa.filter(x => !sb.includes(x));
  if (subjectsAdded.length || subjectsRemoved.length) parts.push({ field: 'subjects', added: subjectsAdded, removed: subjectsRemoved });
  if (keyOf(before.Resource) !== keyOf(after.Resource)) parts.push({ field: 'resource' });
  const other = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !['Effect', 'Action', 'Subject', 'Resource'].includes(key) && keyOf(before[key]) !== keyOf(after[key]));
  if (other.length) parts.push({ field: 'other', keys: other });
  return parts;
}

const names = (tokens, roles) => tokens.map(token => subjectChips(token === '*' ? '*' : [token], roles)[0]?.name ?? token);
const join = items => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);

/** One sentence for a change, written for a reviewer. */
export function changeSentence(change, roles = []) {
  if (change.type === 'added') return statementSentence(change.after, roles);
  if (change.type === 'removed') return 'Removed: ' + statementSentence(change.before, roles);
  if (change.type === 'moved') return 'Moved from position ' + (change.beforeIndex + 1) + ' to ' + (change.afterIndex + 1) + '. The statement itself is unchanged.';
  const who = join(statementSummary(change.after, roles).subjects.map(c => c.name)) || 'Nobody';
  const sentences = [];
  for (const part of change.parts) {
    if (part.field === 'effect') sentences.push('The effect is now ' + part.after + ' (was ' + part.before + ')' + (part.after === 'Deny' ? '. ' + DENY_IGNORED : '.'));
    if (part.field === 'actions') {
      const bits = [];
      if (part.added.length) bits.push(who + ' may now also ' + join(part.added));
      if (part.removed.length) bits.push((part.added.length ? 'and' : who) + ' may no longer ' + join(part.removed));
      sentences.push(bits.join(' ') + '.' + (part.kept.length ? ' ' + join(part.kept) + (part.kept.length === 1 ? ' is' : ' are') + ' unchanged.' : ''));
    }
    if (part.field === 'action-tokens') sentences.push('The operation list is written differently; the operations are the same.');
    if (part.field === 'subjects') {
      if (part.added.length) sentences.push('Now also applies to ' + join(names(part.added, roles)) + '.');
      if (part.removed.length) sentences.push('No longer applies to ' + join(names(part.removed, roles)) + '.');
    }
    if (part.field === 'resource') sentences.push('The objects it applies to changed: now ' + statementSummary(change.after, roles).resource.text + ' (was ' + statementSummary(change.before, roles).resource.text + ').');
    if (part.field === 'other') sentences.push('Other properties changed: ' + part.keys.join(', ') + '.');
  }
  if (change.moved) sentences.push('It also moved from position ' + (change.beforeIndex + 1) + ' to ' + (change.afterIndex + 1) + '.');
  return sentences.join(' ') || 'Changed.';
}

/** Undo one change on the draft statement list. Returns a new list. */
export function revertStatementChange(afterStatements, beforeStatements, change) {
  const result = [...afterStatements];
  if (change.type === 'changed') result[change.afterIndex] = copy(beforeStatements[change.beforeIndex]);
  else if (change.type === 'added') result.splice(change.afterIndex, 1);
  else if (change.type === 'removed') result.splice(Math.min(change.beforeIndex, result.length), 0, copy(beforeStatements[change.beforeIndex]));
  else if (change.type === 'moved') {
    const [item] = result.splice(change.afterIndex, 1);
    result.splice(Math.min(change.beforeIndex, result.length), 0, item);
  }
  return result;
}

/** Review entries for one policy: field changes, then statement changes. */
export function policyChanges(before, after, roles = []) {
  const entries = [];
  if (!before || !after) return entries;
  if (before.name !== after.name) entries.push({ kind: 'field', field: 'name', sentence: 'Renamed from ' + before.name + ' to ' + after.name + '.', before: before.name, after: after.name });
  if (before.enabled !== after.enabled) entries.push({ kind: 'field', field: 'enabled', sentence: after.enabled ? 'The policy is now enabled. Its statements take part in access decisions.' : 'The policy is now disabled. Its statements no longer take part in access decisions.', before: before.enabled ? 'Enabled' : 'Disabled', after: after.enabled ? 'Enabled' : 'Disabled' });
  if (before.parent !== after.parent) entries.push({ kind: 'field', field: 'parent', sentence: 'Moved to another folder. Folders do not change access.', before: before.parent, after: after.parent });
  const sa = before.content?.Statement, sb = after.content?.Statement;
  if (Array.isArray(sa) && Array.isArray(sb)) {
    for (const change of diffStatements(sa, sb)) entries.push({ kind: 'statement', change, sentence: changeSentence(change, roles) });
    const { Statement: _a, ...restBefore } = before.content, { Statement: _b, ...restAfter } = after.content;
    if (keyOf(restBefore) !== keyOf(restAfter)) entries.push({ kind: 'field', field: 'content', sentence: 'Policy properties outside the statements changed (for example Version).', before: '', after: '' });
  } else if (keyOf(before.content) !== keyOf(after.content)) entries.push({ kind: 'field', field: 'content', sentence: 'The policy JSON changed. It has no statement list to compare; review it in the JSON diff.', before: '', after: '' });
  return entries;
}
