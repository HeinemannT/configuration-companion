// One-line statement summaries and whole-statement edits for the Statements view.
// Pure functions over the stored policy JSON. Edits copy only the Statement
// array; every statement keeps its own keys, order and unknown properties.
import { PBAC_ACTIONS, pbacActions, pbacEffect, DENY_IGNORED } from './pbac-syntax';
import { NO_ACTION_TICKED, NO_ONE_NAMED, NO_ONE_NO_ACTION, NO_EFFECT, notAllow } from './access-terms';
import { expressionKind } from './builder-model';
import { comparisonLabels } from './picker-model';
import { ruleDescription } from './pbac-annotations';
import { conditionTree, groupSentence, type TreeNode } from './condition-tree';
import type { PolicyJson } from './schema-model';

export interface RoleRecord { rid: string; id: string; name: string; [field: string]: unknown }
export interface SubjectChip { token: unknown; kind: 'everyone' | 'role' | 'user' | 'other'; name: string; id: string; rid?: string; known?: boolean }

const list = (value: unknown): any[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const isType = (left: unknown) => typeof left === 'string' && ['resource.type', 'new.type'].includes(left.toLowerCase());
/** Display form of a stored value. The stored token is never replaced. */
export const valueLabel = (value: unknown): string => typeof value === 'string' ? value.replace(/^ListPropertySetItem:/, '') : JSON.stringify(value) ?? '';
const field = (left: unknown) => typeof left === 'string' ? left.replace(/^(resource|new)\./, '') : 'expression';

/** Subjects as display chips. Role tokens resolve to the role record when known. */
export function subjectChips(subject: unknown, roles: RoleRecord[] = []): SubjectChip[] {
  if (subject === '*') return [{ token: '*', kind: 'everyone', name: 'Everyone', id: '*' }];
  return list(subject).map((token): SubjectChip => {
    if (typeof token !== 'string') return { token, kind: 'other', name: JSON.stringify(token), id: '' };
    if (token === '*') return { token, kind: 'everyone', name: 'Everyone', id: '*' };
    if (token.startsWith('role:')) {
      const role = roles.find(r => r.id === token.slice(5));
      return { token, kind: 'role', name: role?.name ?? token.slice(5), id: token.slice(5), rid: role?.rid ?? '', known: !!role };
    }
    if (token.startsWith('user:')) return { token, kind: 'user', name: token.slice(5), id: token.slice(5) };
    return { token, kind: 'other', name: token, id: '' };
  });
}

/** Leaf conditions and nested groups in an expression. The root group is not counted. */
export function expressionCounts(node: PolicyJson, depth = 0): { conditions: number; groups: number } {
  const kind = expressionKind(node);
  if (kind === 'All' || kind === 'Any') {
    if (!Array.isArray(node[kind])) return { conditions: 1, groups: 0 };
    return node[kind].reduce((sum: { conditions: number; groups: number }, child: PolicyJson) => {
      const c = expressionCounts(child, depth + 1);
      return { conditions: sum.conditions + c.conditions, groups: sum.groups + c.groups };
    }, { conditions: 0, groups: depth ? 1 : 0 });
  }
  if (node === undefined || node === null) return { conditions: 0, groups: 0 };
  return { conditions: 1, groups: 0 };
}

/** Types required by the statement: a type condition at the root or directly in the root All. */
function requiredTypes(resource: PolicyJson): string[] {
  const kind = expressionKind(resource);
  const nodes = kind === 'All' && Array.isArray(resource.All) ? resource.All : kind === 'Condition' ? [resource] : [];
  const types: string[] = [];
  for (const node of nodes) {
    const c = node?.Condition;
    if (expressionKind(node) === 'Condition' && c && isType(c.Left) && !String(c.Comparison ?? '=').startsWith('Not') && c.Comparison !== '!=')
      types.push(...list(c.Right).filter((v): v is string => typeof v === 'string' && !!v));
  }
  return [...new Set(types)];
}

/** Root-level type conditions counted in the summary's "type:" part. */
function typeNodes(resource: PolicyJson): number {
  const kind = expressionKind(resource);
  const nodes = kind === 'All' && Array.isArray(resource.All) ? resource.All : kind === 'Condition' ? [resource] : [];
  return nodes.filter((node: PolicyJson) => expressionKind(node) === 'Condition' && isType(node.Condition?.Left) && !String(node.Condition.Comparison ?? '=').startsWith('Not') && node.Condition.Comparison !== '!=').length;
}

/** One condition as words: "model is not DEFAULTS". */
export function conditionWords(node: PolicyJson): string {
  const kind = expressionKind(node);
  if (kind === 'Condition') {
    const c = node.Condition ?? {};
    const op = comparisonLabels[c.Comparison ?? '='] ?? String(c.Comparison);
    if (['Empty', 'NotEmpty'].includes(c.Comparison)) return field(c.Left) + ' ' + op;
    const right = c.Right === 'user' ? 'the user' : list(c.Right).map(valueLabel).join(', ');
    return field(c.Left) + ' ' + op + ' ' + right;
  }
  if (kind === 'HasRole') {
    const v = node.HasRole;
    const roles = list(v?.Roles).map(r => String(r).replace(/^role:/, '')).join(', ');
    return field(v?.Reference) + ' has role ' + (roles || '(none)');
  }
  if (kind === 'HasAccessTo') return 'the user has access to ' + field(node.HasAccessTo?.Reference);
  return 'a custom expression';
}

/** One-line summary: effect, subject chips, CRUD flags, resource text. */
export function statementSummary(statement: unknown, roles: RoleRecord[] = []) {
  const s: PolicyJson = statement && typeof statement === 'object' ? statement : {};
  const effect = pbacEffect(s.Effect) ?? (s.Effect === undefined ? 'Missing' : String(s.Effect));
  const granted = s.Action === '*' ? PBAC_ACTIONS : pbacActions(s.Action);
  const actions = Object.fromEntries(PBAC_ACTIONS.map(a => [a, granted.includes(a)]));
  const resource = s.Resource;
  const counts = expressionCounts(resource);
  const types = requiredTypes(resource);
  const typeConditions = typeNodes(resource);
  let text: string;
  if (resource === undefined || resource === null || counts.conditions === 0) text = 'all objects';
  else if (types.length) {
    const shown = types.slice(0, 2).map(valueLabel).join(', ') + (types.length > 2 ? ' +' + (types.length - 2) : '');
    const rest = counts.conditions - typeConditions;
    text = 'type: ' + shown + (rest > 0 || counts.groups ? ' + ' + countText(rest, counts.groups).replace(/^(\d+) condition/, '$1 more condition') : '');
  } else if (counts.conditions === 1 && !counts.groups) {
    const leaf = expressionKind(resource) === 'Condition' ? resource : resource[expressionKind(resource)]?.[0];
    text = 'all objects where ' + conditionWords(leaf);
  } else text = 'objects where ' + countText(counts.conditions, counts.groups);
  const sum = { effect, subjects: subjectChips(s.Subject, roles), actions, resource: { text, types, ...counts },
    note: typeof s === 'object' ? ruleDescription(s) : '', nothing: '' };
  sum.nothing = grantsNothing(sum);
  return sum;
}

function countText(conditions: number, groups: number): string {
  return conditions + (conditions === 1 ? ' condition' : ' conditions') + (groups ? ', ' + groups + (groups === 1 ? ' group' : ' groups') : '');
}

type Summary = { effect: string; subjects: SubjectChip[]; actions: Record<string, boolean> };
const joinAnd = (items: string[]) => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);
/** Why the statement grants nothing as it stands, or '' when it can grant. A Deny is
 *  said separately: it is ignored, not unfinished. */
function grantsNothing(sum: Summary): string {
  if (sum.effect === 'Deny') return '';
  if (sum.effect === 'Missing') return NO_EFFECT;
  if (sum.effect !== 'Allow') return notAllow(sum.effect);
  const nobody = !sum.subjects.some(c => c.name), noAction = !PBAC_ACTIONS.some(a => sum.actions[a]);
  return nobody && noAction ? NO_ONE_NO_ACTION : nobody ? NO_ONE_NAMED : noAction ? NO_ACTION_TICKED : '';
}
/** The sentence once the parts are in words; the plain reason instead when nothing is granted. */
function sentence(sum: Summary, who: string, objects: string): string {
  const acts = PBAC_ACTIONS.filter(a => sum.actions[a]);
  if (sum.effect === 'Deny') return 'Deny ' + (who || 'no one') + (acts.length ? ' ' + joinAnd(acts) : '') + ' on ' + objects + '. ' + DENY_IGNORED;
  return grantsNothing(sum) || who + ' may ' + joinAnd(acts) + ' ' + objects + '.';
}

/** A sentence for the statement, used by the review and the role page. */
export function statementSentence(statement: unknown, roles: RoleRecord[] = []): string {
  const sum = statementSummary(statement, roles), r = sum.resource;
  const rest = r.conditions - typeNodes((statement as PolicyJson)?.Resource);
  const objects = r.types.length ? 'objects of type: ' + joinOr(r.types.map(valueLabel)) + (rest > 0 ? ', when ' + rest + (rest === 1 ? ' more condition holds' : ' more conditions hold') : '')
    : r.text.startsWith('objects where ') ? 'objects that meet ' + r.conditions + ' conditions' : r.text;
  return sentence(sum, joinAnd(sum.subjects.map(c => c.name).filter(Boolean)), objects);
}



const positiveType = (node: TreeNode) => node.kind === 'condition' && isType(node.left) && !String(node.comparison).startsWith('Not') && node.comparison !== '!=';
const joinOr = (items: string[]) => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' or ' + items.at(-1);

/** "Reads as" for the context panel: who, what, which objects, then the remaining conditions once. */
export function readsAs(statement: PolicyJson, roles: RoleRecord[] = []): string {
  const sum = statementSummary(statement, roles), types = sum.resource.types;
  let rest = '';
  if (sum.resource.conditions) {
    let tree: TreeNode | null = conditionTree(statement?.Resource);
    if (types.length && tree.kind === 'group' && tree.op === 'All') tree = { ...tree, children: tree.children.filter(c => !positiveType(c)) };
    else if (types.length && positiveType(tree)) tree = null;
    if (tree && (tree.kind !== 'group' || tree.children.length)) rest = groupSentence(tree);
  }
  const objects = (types.length ? 'objects of type: ' + joinOr(types.map(valueLabel)) : 'all objects') + (rest ? ', when ' + rest : '');
  return sentence(sum, joinAnd(sum.subjects.map(c => c.name).filter(Boolean)), objects);
}

function statementsOf(content: PolicyJson): PolicyJson[] {
  if (!content || !Array.isArray(content.Statement)) throw Error('This policy has no statement list. Edit it in JSON.');
  return content.Statement;
}
const copy = (value: PolicyJson) => JSON.parse(JSON.stringify(value));

/** Move one statement. Returns a new content object; other keys are untouched. */
export function moveStatement(content: PolicyJson, from: number, to: number): PolicyJson {
  const statements = [...statementsOf(content)];
  if (from < 0 || from >= statements.length || to < 0 || to >= statements.length) throw Error('Already at the end of the list.');
  const [item] = statements.splice(from, 1);
  statements.splice(to, 0, item);
  return { ...content, Statement: statements };
}

/** Append a deep copy, as the earlier editor did; the copy is then selected. */
export function duplicateStatement(content: PolicyJson, index: number): PolicyJson {
  const statements = [...statementsOf(content)];
  if (!(index in statements)) throw Error('This statement no longer exists.');
  statements.push(copy(statements[index]));
  return { ...content, Statement: statements };
}

export function removeStatement(content: PolicyJson, index: number): PolicyJson {
  const statements = [...statementsOf(content)];
  if (!(index in statements)) throw Error('This statement no longer exists.');
  statements.splice(index, 1);
  return { ...content, Statement: statements };
}
