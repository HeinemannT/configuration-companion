// What changed in one review entry, in plain words with the actual values.
// Input is a statement change from policy-diff.js (added, removed, moved or
// changed) or a field-assignment row before and after an edit. Output is a list
// of differences; each names the part (Who, Can, On), says what happened, and
// carries only the values that differ, in full.
import { PBAC_ACTIONS, pbacActions, pbacEffect, DENY_IGNORED } from './pbac-syntax';
import { conditionTree, nodeWords, groupSentence, type TreeNode } from './condition-tree';
import { subjectChips, valueLabel, type RoleRecord } from './statement-model';
import { PART, statementLabel, GRANTS_NOTHING_YET, NO_ACTION_TICKED } from './access-terms';
import type { PolicyJson } from './schema-model';

/** One value shown in a Before or After row. `secondary` is muted text, such as an RID. */
export interface ShownValue { text: string; secondary?: string }
export interface Difference {
  /** Who, Can, On, or another word for the part that changed. */
  part: string;
  /** The sentence for the reviewer. */
  text: string;
  /** Row label for the values, for example "On · Type contains any". */
  label: string;
  /** "list": before holds removed values and after holds added values. "replace": old and new value. */
  kind: 'list' | 'replace';
  before: ShownValue[];
  after: ShownValue[];
}
export interface StatementChange {
  type: 'added' | 'removed' | 'moved' | 'changed';
  moved?: boolean;
  beforeIndex: number;
  afterIndex: number;
  before?: PolicyJson;
  after?: PolicyJson;
}

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const join = (items: string[]) => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);
const keyOf = (value: unknown) => JSON.stringify(value);
const short = (left: unknown) => String(left ?? '').replace(/^(resource|new)\./, '');
const shown = (text: string, secondary?: string): ShownValue => secondary ? { text, secondary } : { text };
/** A stored condition value as the reviewer reads it: no class prefix, "user" as "the user". */
export const conditionValue = (value: unknown) => value === 'user' ? 'the user' : valueLabel(value);
const quoted = (label: string) => '“' + label + '”';

function whoNames(subject: unknown, roles: RoleRecord[]): ShownValue[] {
  return subjectChips(subject, roles).map(c => c.kind === 'everyone' ? shown('Everyone', 'every user') : c.kind === 'role' ? shown(c.name, c.id !== c.name ? c.id : undefined) : shown(c.name));
}
const actionsOf = (statement: PolicyJson) => statement?.Action === '*' ? [...PBAC_ACTIONS] : pbacActions(statement?.Action);

/** The label of a condition as it appears in the editor: "Type contains any". */
function conditionLabel(node: TreeNode): string {
  if (node.kind === 'condition') return short(node.left) + ' ' + node.operator;
  if (node.kind === 'hasRole') return short(node.reference) + ' has role';
  if (node.kind === 'hasAccessTo') return 'access to ' + short(node.reference);
  return 'a custom expression';
}

interface Leaf { node: TreeNode; key: string; path: string }
function leaves(tree: TreeNode, out: Leaf[] = []): Leaf[] {
  if (tree.kind === 'group') tree.children.forEach(child => leaves(child, out));
  else out.push({ node: tree, key: keyOf(tree.kind === 'raw' ? tree.value : { ...tree, path: undefined, note: undefined }), path: tree.path.join('/') });
  return out;
}
function groups(tree: TreeNode, out: Map<string, string> = new Map()): Map<string, string> {
  if (tree.kind === 'group') {
    if (!tree.implicit) out.set(tree.path.join('/'), tree.op);
    tree.children.forEach(child => groups(child, out));
  }
  return out;
}
const groupWord = (op: string) => op === 'Any' ? 'Any of' : 'All of';

/** Differences between two Resource expressions. Unchanged conditions are matched
 *  by content wherever they moved; the rest are paired by property, then by place. */
export function conditionDifferences(before: PolicyJson, after: PolicyJson): Difference[] {
  if (keyOf(before) === keyOf(after)) return [];
  const a = conditionTree(before), b = conditionTree(after), out: Difference[] = [];
  const restA = leaves(a), restB = leaves(b);
  // 1. The same condition anywhere is unchanged.
  for (let j = restB.length - 1; j >= 0; j--) {
    const i = restA.findIndex(x => x.key === restB[j].key);
    if (i >= 0) { restA.splice(i, 1); restB.splice(j, 1); }
  }
  // 2. The same property (or reference) is an edited condition; 3. the same place too.
  const pairs: [Leaf, Leaf][] = [];
  const subject = (leaf: Leaf) => leaf.node.kind === 'condition' ? 'c:' + leaf.node.left : leaf.node.kind === 'hasRole' || leaf.node.kind === 'hasAccessTo' ? leaf.node.kind + ':' + leaf.node.reference : '';
  for (const match of [(x: Leaf, y: Leaf) => !!subject(x) && subject(x) === subject(y), (x: Leaf, y: Leaf) => x.path === y.path]) {
    for (let j = 0; j < restB.length; j++) {
      const i = restA.findIndex(x => match(x, restB[j]));
      if (i < 0) continue;
      pairs.push([restA[i], restB[j]]);
      restA.splice(i, 1); restB.splice(j, 1); j--;
    }
  }
  for (const [x, y] of pairs) out.push(...editedCondition(x.node, y.node));
  for (const leaf of restB) out.push({ part: PART.on, kind: 'replace', label: PART.on, before: [], after: [shown(nodeWords(leaf.node))],
    text: 'Added the condition ' + quoted(nodeWords(leaf.node)) + '.' });
  for (const leaf of restA) out.push({ part: PART.on, kind: 'replace', label: PART.on, before: [shown(nodeWords(leaf.node))], after: [],
    text: 'Removed the condition ' + quoted(nodeWords(leaf.node)) + '.' });
  const opsA = groups(a), opsB = groups(b);
  for (const [path, op] of opsB) {
    const was = opsA.get(path);
    if (was && was !== op) out.push({ part: PART.on, kind: 'replace', label: PART.on + ' · group', before: [shown(groupWord(was))], after: [shown(groupWord(op))],
      text: 'Changed a group from ' + groupWord(was) + ' to ' + groupWord(op) + '.' });
  }
  return out;
}

function editedCondition(x: TreeNode, y: TreeNode): Difference[] {
  if (x.kind === 'condition' && y.kind === 'condition') {
    const out: Difference[] = [], label = conditionLabel(y);
    if (x.left !== y.left) out.push({ part: PART.on, kind: 'replace', label: PART.on + ' · property', before: [shown(short(x.left), x.left)], after: [shown(short(y.left), y.left)],
      text: 'Changed the property from ' + short(x.left) + ' to ' + short(y.left) + '.' });
    if (x.comparison !== y.comparison) out.push({ part: PART.on, kind: 'replace', label: PART.on + ' · ' + short(y.left), before: [shown(x.operator)], after: [shown(y.operator)],
      text: 'Changed ' + quoted(short(y.left)) + ' from ' + x.operator + ' to ' + y.operator + '.' });
    const was = x.values.map(keyOf), now = y.values.map(keyOf);
    if (x.list || y.list) {
      const added = y.values.filter((_, i) => !was.includes(now[i])), removed = x.values.filter((_, i) => !now.includes(was[i]));
      const addedText = added.map(conditionValue), removedText = removed.map(conditionValue);
      if (added.length) out.push({ part: PART.on, kind: 'list', label: PART.on + ' · ' + label, before: [], after: addedText.map(t => shown(t)),
        text: 'Added ' + join(addedText) + ' to ' + quoted(label) + '.' });
      if (removed.length) out.push({ part: PART.on, kind: 'list', label: PART.on + ' · ' + label, before: removedText.map(t => shown(t)), after: [],
        text: 'Removed ' + join(removedText) + ' from ' + quoted(label) + '.' });
      if (!added.length && !removed.length && keyOf(was) !== keyOf(now)) out.push({ part: PART.on, kind: 'replace', label: PART.on + ' · ' + label,
        before: [shown(x.values.map(conditionValue).join(', '))], after: [shown(y.values.map(conditionValue).join(', '))], text: 'Reordered the values of ' + quoted(label) + '.' });
    } else if (keyOf(was) !== keyOf(now)) {
      const from = x.values.map(conditionValue).join(', ') || '(no value)', to = y.values.map(conditionValue).join(', ') || '(no value)';
      out.push({ part: PART.on, kind: 'replace', label: PART.on + ' · ' + label, before: [shown(from)], after: [shown(to)],
        text: 'Changed ' + quoted(label) + ' from ' + from + ' to ' + to + '.' });
    }
    return out;
  }
  return [{ part: PART.on, kind: 'replace', label: PART.on, before: [shown(nodeWords(x))], after: [shown(nodeWords(y))],
    text: 'Changed the condition ' + quoted(nodeWords(x)) + ' to ' + quoted(nodeWords(y)) + '.' }];
}

/** Who, Can, On and the remaining properties of a changed statement. */
function editedStatement(before: PolicyJson, after: PolicyJson, roles: RoleRecord[]): Difference[] {
  const out: Difference[] = [];
  const effectBefore = pbacEffect(before.Effect) ?? String(before.Effect), effectAfter = pbacEffect(after.Effect) ?? String(after.Effect);
  if (effectBefore !== effectAfter) out.push({ part: 'Effect', kind: 'replace', label: 'Effect', before: [shown(effectBefore)], after: [shown(effectAfter)],
    text: 'Changed the effect from ' + effectBefore + ' to ' + effectAfter + '.' + (effectAfter === 'Deny' ? ' ' + DENY_IGNORED : '') });
  const tokensA = list(before.Subject === '*' ? '*' : before.Subject).map(String), tokensB = list(after.Subject === '*' ? '*' : after.Subject).map(String);
  const whoAdded = tokensB.filter(t => !tokensA.includes(t)), whoRemoved = tokensA.filter(t => !tokensB.includes(t));
  const names = (tokens: string[]) => whoNames(tokens.length === 1 && tokens[0] === '*' ? '*' : tokens, roles);
  if (whoAdded.length && whoRemoved.length) out.push({ part: PART.who, kind: 'replace', label: PART.who, before: whoNames(before.Subject, roles), after: whoNames(after.Subject, roles),
    text: 'Changed who from ' + join(whoNames(before.Subject, roles).map(v => v.text)) + ' to ' + join(whoNames(after.Subject, roles).map(v => v.text)) + '.' + (tokensB.includes('*') ? ' It now applies to every user.' : '') });
  else if (whoAdded.length) out.push({ part: PART.who, kind: 'list', label: PART.who, before: [], after: names(whoAdded),
    text: join(names(whoAdded).map(v => v.text)) + ' added to who.' + (whoAdded.includes('*') ? ' It now applies to every user.' : '') });
  else if (whoRemoved.length) out.push({ part: PART.who, kind: 'list', label: PART.who, before: names(whoRemoved), after: [],
    text: join(names(whoRemoved).map(v => v.text)) + ' removed from who.' });
  const who = join(whoNames(after.Subject, roles).map(v => v.text)) || 'nobody';
  const can = new Set(actionsOf(before)), now = new Set(actionsOf(after));
  const opsAdded = PBAC_ACTIONS.filter(a => now.has(a) && !can.has(a)), opsRemoved = PBAC_ACTIONS.filter(a => can.has(a) && !now.has(a));
  if (opsAdded.length) out.push({ part: PART.can, kind: 'list', label: PART.can, before: [], after: opsAdded.map(a => shown(a)), text: join([...opsAdded]) + ' added for ' + who + '.' });
  if (opsRemoved.length) out.push({ part: PART.can, kind: 'list', label: PART.can, before: opsRemoved.map(a => shown(a)), after: [],
    text: join([...opsRemoved]) + ' removed for ' + who + '.' + (now.size ? '' : ' ' + NO_ACTION_TICKED.replace('yet', 'now')) });
  if (!opsAdded.length && !opsRemoved.length && keyOf(before.Action) !== keyOf(after.Action))
    out.push({ part: PART.can, kind: 'replace', label: PART.can, before: [shown(keyOf(before.Action))], after: [shown(keyOf(after.Action))], text: 'The operation list is written differently; the operations are the same.' });
  out.push(...conditionDifferences(before.Resource, after.Resource));
  const other = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !['Effect', 'Action', 'Subject', 'Resource'].includes(key) && keyOf(before[key]) !== keyOf(after[key]));
  for (const key of other) out.push({ part: key, kind: 'replace', label: key, before: before[key] === undefined ? [] : [shown(typeof before[key] === 'string' ? before[key] : keyOf(before[key]))],
    after: after[key] === undefined ? [] : [shown(typeof after[key] === 'string' ? after[key] : keyOf(after[key]))], text: 'Changed ' + key + '.' });
  return out;
}

/** A whole statement as Who / Can / On rows, for an added or removed statement. */
function wholeStatement(statement: PolicyJson, roles: RoleRecord[], side: 'before' | 'after'): Difference[] {
  const tree = conditionTree(statement?.Resource);
  const on = tree.kind === 'group' && !tree.children.length ? 'all objects' : groupSentence(tree);
  const ops = actionsOf(statement);
  const rows: [string, ShownValue[]][] = [[PART.who, whoNames(statement?.Subject, roles)], [PART.can, ops.length ? ops.map(a => shown(a)) : [shown(GRANTS_NOTHING_YET, 'no action is ticked')]], [PART.on, [shown(on)]]];
  return rows.map(([part, values]) => ({ part, kind: 'replace', label: part, before: side === 'before' ? values : [], after: side === 'after' ? values : [], text: '' }));
}

/** Differences for one statement change from diffStatements. */
export function statementDifferences(change: StatementChange, roles: RoleRecord[] = []): Difference[] {
  const position = (i: number) => (i + 1);
  if (change.type === 'added') return [{ part: 'Statement', kind: 'replace', label: '', before: [], after: [], text: 'Added ' + statementLabel(change.afterIndex).toLowerCase() + '.' + (change.after?.Subject === '*' ? ' It applies to every user.' : '') },
    ...wholeStatement(change.after, roles, 'after')];
  if (change.type === 'removed') return [{ part: 'Statement', kind: 'replace', label: '', before: [], after: [], text: 'Removed ' + statementLabel(change.beforeIndex).toLowerCase() + '.' },
    ...wholeStatement(change.before, roles, 'before')];
  const moved: Difference = { part: 'Position', kind: 'replace', label: 'Position', before: [shown(String(position(change.beforeIndex)))], after: [shown(String(position(change.afterIndex)))],
    text: 'Moved from position ' + position(change.beforeIndex) + ' to ' + position(change.afterIndex) + '.' };
  if (change.type === 'moved') return [{ ...moved, text: moved.text + ' The statement itself is unchanged.' }];
  const out = editedStatement(change.before ?? {}, change.after ?? {}, roles);
  return change.moved ? [...out, moved] : out;
}

/** A field assignment or delegation row whose field changed. Names come first; the
 *  RID of the field definition is secondary. `fieldOf` names a definition RID. */
export function fieldDifference(before: PolicyJson, after: PolicyJson, fieldOf: (rid: string) => string | undefined): Difference | null {
  if (!before || !after) return null;
  const fieldChanged = before.field !== after.field, ridChanged = (before.referenceConfig ?? '') !== (after.referenceConfig ?? '');
  if (!fieldChanged && !ridChanged) return null;
  const side = (row: PolicyJson, other: PolicyJson): ShownValue => {
    const rid = String(row.referenceConfig ?? ''), name = row.field || (rid && fieldOf(rid)) || 'No field';
    if (!rid) return shown(name, other.referenceConfig ? 'RID set on save from the live schema' : undefined);
    return shown(name, 'RID ' + rid);
  };
  const was = side(before, after), now = side(after, before);
  return { part: 'Field', kind: 'replace', label: 'Field', before: [was], after: [now],
    text: fieldChanged ? 'Changed the field from ' + was.text + ' to ' + now.text + '.' : 'The field ' + now.text + ' now points to another definition.' };
}

/** Name of a field definition RID in loaded class metadata: "Organisation.managers". */
export function fieldNameOf(classes: Record<string, { rid?: string; accessor?: string; label?: string }[] | undefined>, rid: string): string | undefined {
  for (const [type, props] of Object.entries(classes)) {
    const prop = props?.find(p => String(p.rid) === rid);
    if (prop) return type + '.' + (prop.accessor ?? prop.label ?? rid);
  }
  return undefined;
}
