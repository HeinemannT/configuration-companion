import { PBAC_EXPRESSIONS } from './pbac-syntax.js';
const copy = value => JSON.parse(JSON.stringify(value));
const at = (root, path) => path.reduce((value, key) => value?.[key], root);
export function expressionKind(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const keys = Object.keys(node).filter(k => PBAC_EXPRESSIONS.has(k) && node[k] != null);
  return keys.length === 1 ? keys[0] : '';
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
export function duplicateIndices(nodes) {
  const seen = new Map(),
    duplicates = new Map();
  nodes.forEach((node, index) => {
    const key = JSON.stringify(stable(node));
    if (seen.has(key)) duplicates.set(index, seen.get(key));
    else seen.set(key, index);
  });
  return duplicates;
}
export function transformExpression(root, path, operation) {
  const result = copy(root),
    node = at(result, path);
  if (node === undefined) throw Error('This condition no longer exists.');
  const replace = value => {
    if (!path.length) return value;
    at(result, path.slice(0, -1))[path.at(-1)] = value;
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
    index = path.at(-1);
  if (!Array.isArray(siblings) || !Number.isInteger(index)) throw Error('Select a condition inside a group.');
  if (operation === 'duplicate') siblings.splice(index + 1, 0, copy(node));
  else if (operation === 'up' || operation === 'down') {
    const next = index + (operation === 'up' ? -1 : 1);
    if (next < 0 || next >= siblings.length) throw Error('Already at the end of this group.');
    [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
  } else throw Error('Unknown condition action.');
  return result;
}
