import { activePBACExpressions, classifyPBACRight, PBAC_COMPARISONS } from './pbac-syntax.js';
import { contradictoryAll } from './matrix-constraints.js';

// Coverage evidence, not an implementation of BMP's access engine. Unresolved
// branches never become CRUD merely because we could not disprove them.
export const EXCLUDED = 0, DEFINITE = 1, CONDITIONAL = 2, UNRESOLVED = 3;
const list = v => Array.isArray(v) ? v : [v];
const fact = (truth, anchored = false, blocked = false, reason = '') => ({ truth, anchored, blocked, reasons: reason ? [reason] : [] });
const unknown = reason => fact(null, false, true, reason);
const inverse = v => v == null ? null : !v;
const any = values => values.includes(true) ? true : values.every(v => v === false) ? false : null;
const all = values => values.includes(false) ? false : values.every(v => v === true) ? true : null;
const positive = new Set(['=', 'Equal', '~', 'Contains', 'ContainsAny', 'ContainsAll']);

export function collectMatrixReferences(model) {
  const tokens = new Set();
  function visit(v) {
    if (!v || typeof v !== 'object') return;
    // Only identities used to establish the row's object type need resolving.
    if (v.Condition && ['resource', 'resource.linkedTo'].includes(v.Condition.Left) && classifyPBACRight(v.Condition.Left, v.Condition.Right).kind === 'objects') {
      for (const token of list(v.Condition.Right)) tokens.add(token);
    }
    Object.values(v).forEach(visit);
  }
  for (const policy of model.policies) if (policy.enabled && policy.valid !== false) visit(policy.content?.Statement);
  return [...tokens];
}

export function matrixTypeGraph(metadata, fallback = {}) {
  if (!metadata?.types) {
    const graph = { ...fallback };
    // The saved ClassConfig catalogue is partial. Its positive edges are useful,
    // but a missing edge cannot establish a negative comparison as a grant.
    Object.defineProperty(graph, 'complete', { value: false });
    return graph;
  }
  const children = Object.fromEntries(Object.keys(metadata.types).map(t => [t, []]));
  const ancestors = new Map();
  function parents(type, path = new Set()) {
    if (ancestors.has(type)) return ancestors.get(type);
    if (path.has(type)) throw new Error('Cyclic BMP type catalogue.');
    // BMP omits Java helper interfaces (Serializable, etc.). Preserve known
    // edges, but mark affected types incomplete instead of inventing negatives.
    if (!Object.hasOwn(metadata.types, type)) return new Set([type]);
    const result = new Set([type]), next = new Set([...path, type]);
    for (const parent of metadata.types[type].parents) for (const p of parents(parent, next)) result.add(p);
    ancestors.set(type, result); return result;
  }
  const incomplete = new Set();
  for (const type of Object.keys(metadata.types)) for (const parent of parents(type)) {
    if (!Object.hasOwn(metadata.types, parent)) incomplete.add(type);
    (children[parent] ??= []).push(type);
  }
  Object.defineProperty(children, 'incomplete', {value:incomplete});
  return children;
}

function scalarComparison(comparison, right, matches) {
  const one = list(right).length === 1, isList = Array.isArray(right);
  switch (comparison) {
    case '=': case 'Equal': return one ? any(matches) : false;
    case '!=': case 'NotEqual': return one ? inverse(any(matches)) : true;
    case '~': case 'Contains': return isList ? any(matches) : false;
    case '!~': case 'NotContains': return isList ? inverse(any(matches)) : true;
    case 'ContainsAny': return any(matches);
    case 'NotContainsAny': return inverse(any(matches));
    case 'ContainsAll': return all(matches);
    case 'NotContainsAll': return inverse(all(matches));
    default: return null;
  }
}

export function evaluateMatrixExpression(expression, context, depth = 0) {
  const { type, action, children = {}, metadata, roleIds } = context;
  if (expression === '*') return fact(true);
  if (!expression || typeof expression !== 'object' || depth > 64) return unknown('Unsupported expression');
  if (activePBACExpressions(expression).length !== 1) return unknown('Ambiguous expression');
  for (const group of ['All', 'Any']) if (Array.isArray(expression[group])) {
    if (group === 'All' && contradictoryAll(expression, metadata)) return fact(false);
    const values = [];
    for (const child of expression[group]) {
      const value = evaluateMatrixExpression(child, context, depth + 1);
      if (group === 'All' && value.truth === false || group === 'Any' && value.truth === true) return value;
      values.push(value);
    }
    const truth = (group === 'All' ? all : any)(values.map(v => v.truth));
    if (truth != null) return fact(truth, values.some(v => v.anchored));
    const pending = values.filter(v => v.truth == null);
    // An Any branch is independently sufficient. An All branch needs every
    // pending term; a type guard must never leak out of an alternative branch.
    const supported = group === 'Any' ? pending.filter(v => v.anchored && !v.blocked) : [];
    return { truth, anchored: group === 'All' ? values.some(v => v.anchored) : supported.length > 0,
      blocked: group === 'All' ? pending.some(v => v.blocked) : !supported.length,
      reasons: [...new Set((supported.length ? supported : pending).flatMap(v => v.reasons))],
      // A supported conditional path and unresolved alternatives can coexist.
      // They do not add grants; keep their explanation for the inspector.
      unresolvedReasons: [...new Set(pending.flatMap(v => [
        ...(v.unresolvedReasons ?? []), ...(group === 'Any' && (v.blocked || !v.anchored) ? v.reasons : [])
      ]))] };
  }
  if (expression.HasRole) {
    const roles = expression.HasRole.Roles;
    if (!Array.isArray(roles) || !roles.length || !roleIds) return unknown('Role membership requires evaluation');
    // A matrix row simulates the Role entity, not a User with local assignments.
    return fact(roles.some(id => roleIds.has(id)));
  }
  if (expression.HasAccessTo) return unknown('Related-object access requires an engine test');
  const c = expression.Condition;
  if (!c || !PBAC_COMPARISONS.has(c.Comparison)) return unknown('Unsupported comparison');
  const left = c.Left, comparison = c.Comparison;
  if (typeof left !== 'string') return unknown('Unsupported operand');
  const absent = action === 'Create' && (left === 'resource' || left.startsWith('resource.')) ||
    ['Read', 'Delete'].includes(action) && left.startsWith('new.');
  if (absent) return fact(['Empty', '!=', 'NotEqual'].includes(comparison));
  if (c.Right === 'user' && !['Empty', 'NotEmpty'].includes(comparison)) return unknown('Personal access requires a User test');
  if (left.startsWith('new.') && action === 'Update') return unknown('Depends on submitted changes');
  if (['resource.type', 'new.type'].includes(left)) {
    const right = list(c.Right);
    if (['Empty', 'NotEmpty'].includes(comparison)) return fact(comparison === 'NotEmpty');
    if (classifyPBACRight(left, c.Right).kind !== 'types' || right.some(v => typeof v !== 'string')) return unknown('Invalid or unresolved type operand');
    if (comparison === 'ExactTypeOf') return fact(!Array.isArray(c.Right) && c.Right === type, true);
    const matches = right.map(v => v === type || children[v]?.includes(type) ? true : children.complete !== false && Object.hasOwn(children, type) && Object.hasOwn(children, v) && !children.incomplete?.has(type) ? false : null);
    const truth = scalarComparison(comparison, c.Right, matches);
    return truth == null ? unknown('Type inheritance unavailable') : fact(truth, positive.has(comparison) && truth);
  }
  if (['resource', 'resource.linkedTo'].includes(left) && classifyPBACRight(left, c.Right).kind === 'objects') {
    const refs = list(c.Right).map(token => metadata?.references?.[token]);
    if (refs.some(v => v === undefined || v === null)) return unknown('Object reference unavailable or missing');
    if (comparison === 'ContainsAll' && new Set(refs.map(v => v.rid)).size > 1) return fact(false);
    const compatible = refs.map(v => v.type === type);
    // Repository link creation and affixLink preserve exact class. This is a
    // normal-model invariant, not a claim that PBAC validates damaged storage.
    const possible = scalarComparison(comparison, c.Right, compatible.map(v => v ? null : false));
    if (positive.has(comparison)) {
      if (possible === false) return fact(false);
      return fact(null, compatible.some(Boolean), false, left === 'resource' ? 'Only the referenced objects' : 'Only objects linked to these templates');
    }
    // Missing linkedTo has different negative-comparator semantics. Do not
    // infer universal negative coverage from class incompatibility alone.
    return unknown('Reference exclusion requires object values');
  }
  if (left === 'resource.model' || left === 'new.model') return unknown('Model-restricted access; test an object in that model');
  if (/^(resource|new)\.[A-Za-z_][A-Za-z0-9_]*$/.test(left)) return fact(null, false, false, 'Depends on object or submitted field values');
  return unknown('Operand requires engine evaluation');
}

export function coverageStatus(result) {
  return result.truth === false ? EXCLUDED : result.truth === true ? DEFINITE : result.anchored && !result.blocked ? CONDITIONAL : UNRESOLVED;
}
export const typeMatch = (expression, type, action, children = {}) => evaluateMatrixExpression(expression, { type, action, children }).truth;
