import { activePBACExpressions, classifyPBACRight } from './pbac-syntax.js';

// Only necessary conditions in the same conjunction are compared. In
// particular, never combine constraints from different Any alternatives.
const plans = new WeakMap();
const aliases = { '=':'Equal', '!=':'NotEqual', '~':'Contains', '!~':'NotContains' };
const opposite = { Empty:'NotEmpty', Equal:'NotEqual', Contains:'NotContains', ContainsAny:'NotContainsAny', ContainsAll:'NotContainsAll' };
function plan(expression) {
  if (plans.has(expression)) return plans.get(expression);
  const queue = [expression], conditions = [], predicates = new Map();
  let impossible = false, visited = 0;
  while (queue.length && visited++ < 256) {
    const item = queue.pop();
    if (!item || typeof item !== 'object' || activePBACExpressions(item).length !== 1) continue;
    if (Array.isArray(item.All)) { queue.push(...item.All.slice(0, 256)); continue; }
    const c = item.Condition;
    if (!c || typeof c.Left !== 'string' || !/^(resource|new)(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(c.Left)) continue;
    const op = aliases[c.Comparison] ?? c.Comparison;
    const unary = ['Empty','NotEmpty'].includes(op);
    // Compare exact literal operands only; do not invent equivalence between
    // scalar/list comparisons or resolve arbitrary field value domains.
    if (!unary && !(typeof c.Right === 'string' || typeof c.Right === 'number' || typeof c.Right === 'boolean' ||
        Array.isArray(c.Right) && c.Right.every(v => ['string','number','boolean'].includes(typeof v)))) continue;
    const key = JSON.stringify([c.Left, unary ? null : c.Right]);
    if (!predicates.has(key)) predicates.set(key, new Set());
    const seen = predicates.get(key); seen.add(op);
    if (Object.entries(opposite).some(([a,b]) => seen.has(a) && seen.has(b))) impossible = true;
    if (['resource','resource.linkedTo'].includes(c.Left) && classifyPBACRight(c.Left,c.Right).kind === 'objects') conditions.push({...c,Comparison:op});
  }
  const result = { impossible, conditions }; plans.set(expression,result); return result;
}

export function contradictoryAll(expression, metadata) {
  const { impossible, conditions } = plan(expression);
  if (impossible) return true;
  const allowed = new Map();
  for (const c of conditions) {
    if (!['Equal','Contains','ContainsAny','ContainsAll'].includes(c.Comparison)) continue;
    const tokens = Array.isArray(c.Right) ? c.Right : [c.Right];
    if (c.Comparison === 'Equal' && tokens.length !== 1 || c.Comparison === 'Contains' && !Array.isArray(c.Right)) continue;
    const refs = tokens.map(token => metadata?.references?.[token]);
    if (refs.some(ref => !ref)) continue;
    const ids = new Set(refs.map(ref => ref.rid));
    if (c.Comparison === 'ContainsAll' && ids.size > 1) return true;
    // ContainsAll([]) is vacuously true, not an empty set of allowed identities.
    if (c.Comparison === 'ContainsAll' && !ids.size) continue;
    const previous = allowed.get(c.Left);
    const intersection = previous ? new Set([...ids].filter(id => previous.has(id))) : ids;
    if (!intersection.size) return true;
    allowed.set(c.Left,intersection);
  }
  return false;
}
