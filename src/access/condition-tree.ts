// View model and edits for a statement's Resource expression.
// Every node keeps its JSON path. Anything the Rules view cannot show faithfully
// becomes a raw node: it is displayed as marked JSON and only edited in JSON.
// Edits copy the Resource and change one path; other nodes keep their keys and order.
import { expressionKind } from './builder-model';
import { comparisonLabels } from './picker-model';
import { isPBACAnnotation } from './pbac-annotations';
import { pbacAction, pbacGrouping } from './pbac-syntax';
import type { PolicyJson } from './schema-model';

export type ExprPath = (string | number)[];
export interface RawNode { kind: 'raw'; path: ExprPath; value: unknown; reason: string }
export interface GroupNode { kind: 'group'; op: string; path: ExprPath; note: string; children: TreeNode[]; implicit?: boolean }
export interface ConditionNode {
  kind: 'condition'; path: ExprPath; note: string; left: string; comparison: string; operator: string;
  known: boolean; values: unknown[]; list: boolean; unary: boolean;
}
export interface HasRoleNode { kind: 'hasRole'; path: ExprPath; note: string; reference: string; roles: unknown[] }
export interface HasAccessToNode {
  kind: 'hasAccessTo'; path: ExprPath; note: string; reference: string; roles: unknown[]; action: string; grouping: string;
}
export type TreeNode = RawNode | GroupNode | ConditionNode | HasRoleNode | HasAccessToNode;

const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const notes = (node: object, known: string[]) => Object.keys(node).filter(key => !known.includes(key));
const copy = (value: PolicyJson) => JSON.parse(JSON.stringify(value));
const at = (root: PolicyJson, path: readonly (string | number)[]): PolicyJson => path.reduce((value, key) => value?.[key], root);

function raw(value: unknown, path: ExprPath, reason: string): RawNode {
  return { kind: 'raw', path, value, reason };
}

/** Build the display tree. `path` is relative to the statement's Resource. */
export function conditionTree(node?: PolicyJson, path: ExprPath = []): TreeNode {
  if (node === undefined) return { kind: 'group', op: 'All', path, children: [], implicit: true, note: '' };
  if (!plain(node)) return raw(node, path, 'This expression is not an object.');
  const kind = expressionKind(node);
  if (!kind) return raw(node, path, Object.keys(node).length ? 'This expression has more than one operator or none.' : 'This expression is empty.');
  const extra = notes(node, [kind]);
  const unknown = extra.filter(key => !isPBACAnnotation(key) && node[key] != null);
  if (unknown.length) return raw(node, path, 'Unknown keys: ' + unknown.join(', ') + '.');
  const note = extra.filter(isPBACAnnotation).map(key => typeof node[key] === 'string' ? node[key] : '').filter(Boolean).join(' ');
  if (kind === 'All' || kind === 'Any') {
    if (!Array.isArray(node[kind])) return raw(node, path, kind + ' must hold a list.');
    return { kind: 'group', op: kind, path, note, children: node[kind].map((child: PolicyJson, i: number) => conditionTree(child, [...path, kind, i])) };
  }
  if (kind === 'Condition') {
    const c = node.Condition;
    if (!plain(c) || typeof c.Left !== 'string') return raw(node, path, 'The condition needs a Left property.');
    const odd = notes(c, ['Left', 'Comparison', 'Right']);
    if (odd.length) return raw(node, path, 'Unknown keys: ' + odd.join(', ') + '.');
    if (!(scalar(c.Right) || c.Right === undefined || Array.isArray(c.Right) && c.Right.every(scalar))) return raw(node, path, 'The value is not a single value or a list of values.');
    const comparison = c.Comparison ?? '=';
    return { kind: 'condition', path, note, left: c.Left, comparison, operator: comparisonLabels[comparison] ?? comparison,
      known: !!comparisonLabels[comparison], values: Array.isArray(c.Right) ? c.Right : c.Right === undefined ? [] : [c.Right],
      list: Array.isArray(c.Right), unary: ['Empty', 'NotEmpty'].includes(comparison) };
  }
  const v = node[kind];
  if (!plain(v)) return raw(node, path, kind + ' must be an object with a Reference.');
  const odd = notes(v, kind === 'HasRole' ? ['Reference', 'Roles'] : ['Reference', 'Roles', 'Action', 'Grouping']);
  if (odd.length) return raw(node, path, 'Unknown keys: ' + odd.join(', ') + '.');
  const roles = Array.isArray(v.Roles) ? v.Roles : v.Roles === undefined ? [] : [v.Roles];
  if (kind === 'HasRole') return { kind: 'hasRole', path, note, reference: v.Reference ?? '', roles };
  return { kind: 'hasAccessTo', path, note, reference: v.Reference ?? '', roles, action: pbacAction(v.Action) ?? '',
    grouping: pbacGrouping(v.Grouping) ?? '' };
}

/** Raw nodes in a tree, for the "edit in JSON" notice. */
export function rawNodes(tree: TreeNode): RawNode[] {
  if (tree.kind === 'raw') return [tree];
  return tree.kind === 'group' ? tree.children.flatMap(rawNodes) : [];
}

/** Nesting depth of a path: the number of groups above the node. */
export const groupDepth = (path: ExprPath) => path.filter(key => key === 'All' || key === 'Any').length;

/** Flip All <-> Any at a group path. Same JSON as the earlier editor produced. */
export function flipGroup(resource: PolicyJson, path: ExprPath, to?: string): PolicyJson {
  const result = copy(resource), node = at(result, path), from = expressionKind(node);
  if (from !== 'All' && from !== 'Any') throw Error('Select a group to change All or Any.');
  const next = to ?? (from === 'All' ? 'Any' : 'All');
  if (next === from) return result;
  node[next] = node[from];
  delete node[from];
  return result;
}

/** New nodes as the earlier editor created them. */
export function newCondition(kind: string, scope = 'resource'): PolicyJson {
  return copy({
    Condition: { Condition: { Left: scope + '.type', Comparison: '=', Right: '' } },
    All: { All: [] }, Any: { Any: [] },
    HasRole: { HasRole: { Reference: scope + '.', Roles: [] } },
    HasAccessTo: { HasAccessTo: { Reference: scope + '.', Roles: [], Action: 'Read' } }
  }[kind]);
}

/** Add a node to the group at `path`, or wrap a single node in an All. */
export function insertCondition(resource: PolicyJson, path: ExprPath, kind: string, scope = 'resource'): PolicyJson {
  const node = newCondition(kind, scope);
  if (!node) throw Error('Unknown condition kind.');
  if (resource === undefined && !path.length) return { All: [node] };
  const result = copy(resource), target = at(result, path);
  if (Array.isArray(target?.All)) target.All.push(node);
  else if (Array.isArray(target?.Any)) target.Any.push(node);
  else if (!path.length) return { All: [result, node] };
  else at(result, path.slice(0, -1))[path.at(-1) as string | number] = { All: [target, node] };
  return result;
}

/** Remove a node. Removing the root leaves an empty All, which matches everything. */
export function removeCondition(resource: PolicyJson, path: ExprPath): PolicyJson {
  if (!path.length) return { All: [] };
  const result = copy(resource), parent = at(result, path.slice(0, -1));
  if (Array.isArray(parent)) parent.splice(path.at(-1) as number, 1);
  else parent[path.at(-1) as string | number] = { All: [] };
  return result;
}

/** Set one value inside the Resource. */
export function setAt(resource: PolicyJson, path: ExprPath, value: unknown): PolicyJson {
  if (!path.length) return copy(value);
  const result = copy(resource), parent = at(result, path.slice(0, -1));
  if (!parent || typeof parent !== 'object') throw Error('This condition no longer exists.');
  parent[path.at(-1) as string | number] = value;
  return result;
}

const short = (left: unknown) => String(left ?? '').replace(/^(resource|new)\./, '');
/** One tree node in words: "status is not Retired". */
export function nodeWords(node: TreeNode): string {
  if (node.kind === 'condition') {
    if (node.unary) return short(node.left) + ' ' + node.operator;
    const values = node.values.map((v: unknown) => v === 'user' ? 'the user' : typeof v === 'string' ? v.replace(/^ListPropertySetItem:/, '') : JSON.stringify(v));
    return short(node.left) + ' ' + node.operator + ' ' + (values.join(', ') || '(no value)');
  }
  if (node.kind === 'hasRole') return short(node.reference) + ' has role ' + (node.roles.map(r => String(r).replace(/^role:/, '')).join(', ') || '(none)');
  if (node.kind === 'hasAccessTo') return 'the user has access to ' + short(node.reference);
  return 'a custom expression';
}

/** Plain-language reading of a group, for the context panel. */
export function groupSentence(tree: TreeNode, words: (node: TreeNode) => string = nodeWords): string {
  if (tree.kind !== 'group') return words(tree);
  const parts = tree.children.map(child => child.kind === 'group' ? '(' + groupSentence(child, words) + ')' : words(child));
  if (!parts.length) return tree.op === 'All' ? 'always' : 'never';
  return parts.join(tree.op === 'All' ? ' and ' : ' or ');
}

/** Path of the node insertCondition adds, so the editor can reveal and focus it. */
export function insertedPath(resource: PolicyJson, path: ExprPath): ExprPath {
  if (resource === undefined && !path.length) return ['All', 0];
  const target = at(resource, path);
  if (Array.isArray(target?.All)) return [...path, 'All', target.All.length];
  if (Array.isArray(target?.Any)) return [...path, 'Any', target.Any.length];
  return [...path, 'All', 1];
}

/** A list value edited as chips: remove one item, keeping the others and their JSON types. */
export function removeValue(resource: PolicyJson, conditionPath: ExprPath, index: number): PolicyJson {
  const right = at(resource, [...conditionPath, 'Condition', 'Right']);
  if (!Array.isArray(right) || !(index in right)) throw Error('This value no longer exists.');
  return setAt(resource, [...conditionPath, 'Condition', 'Right'], right.filter((_: unknown, i: number) => i !== index));
}

/** Add one typed value. Numbers and booleans stay numbers and booleans when the list holds only those. */
export function addValue(resource: PolicyJson, conditionPath: ExprPath, text: string): PolicyJson {
  const right = at(resource, [...conditionPath, 'Condition', 'Right']);
  if (!Array.isArray(right)) throw Error('This value is not a list.');
  const value = text.trim();
  if (!value) return resource;
  let typed: string | number | boolean = value;
  if (right.length && right.every((v: unknown) => typeof v === 'number') && Number.isFinite(Number(value))) typed = Number(value);
  else if (right.length && right.every((v: unknown) => typeof v === 'boolean') && /^(true|false)$/.test(value)) typed = value === 'true';
  if (right.includes(typed)) return resource;
  return setAt(resource, [...conditionPath, 'Condition', 'Right'], [...right, typed]);
}