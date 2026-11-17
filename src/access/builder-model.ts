import { PBAC_EXPRESSIONS } from './pbac-syntax';
import type { PolicyJson } from './schema-model';
const copy = (value: PolicyJson) => JSON.parse(JSON.stringify(value));
type Path = readonly (string | number)[];
const at = (root: PolicyJson, path: Path): PolicyJson => path.reduce((value, key) => value?.[key], root);
export function expressionKind(node: PolicyJson): string {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const keys = Object.keys(node).filter(k => PBAC_EXPRESSIONS.has(k) && node[k] != null);
  return keys.length === 1 ? keys[0] : '';
}

function stable(value: PolicyJson): PolicyJson {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export function duplicateIndices(nodes: PolicyJson[]): Map<number, number> {
  const seen = new Map<string, number>(),
    duplicates = new Map<number, number>();
  nodes.forEach((node, index) => {
    const key = JSON.stringify(stable(node));
    if (seen.has(key)) duplicates.set(index, seen.get(key) as number);
    else seen.set(key, index);
  });
  return duplicates;
}
export function transformExpression(root: PolicyJson, path: Path, operation: string): PolicyJson {
  const result = copy(root),
    node = at(result, path);
  if (node === undefined) throw Error('This condition no longer exists.');
  const replace = (value: PolicyJson) => {
    if (!path.length) return value;
    at(result, path.slice(0, -1))[path.at(-1) as string | number] = value;
    return result;
  };
  if (operation === 'all' || operation === 'any') return replace({
    [operation === 'all' ? 'All' : 'Any']: [node]
  });
  if (operation === 'unwrap') {
    const kind = expressionKind(node);
    if (!['All', 'Any'].includes(kind) || !Array.isArray(node[kind]) || node[kind].length !== 1 || Object.keys(node).length !== 1)
    throw Error('Only a group with one condition and no extra fields can be unwrapped.');
    return replace(node[kind][0]);
  }
  const siblings = at(result, path.slice(0, -1)),
    index = path.at(-1) as number;
  if (!Array.isArray(siblings) || !Number.isInteger(index)) throw Error('Select a condition inside a group.');
  if (operation === 'duplicate') siblings.splice(index + 1, 0, copy(node));
  else if (operation === 'up' || operation === 'down') {
    const next = index + (operation === 'up' ? -1 : 1);
    if (next < 0 || next >= siblings.length) throw Error('Already at the end of this group.');
    [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
  } else throw Error('Unknown condition action.');
  return result;
}
