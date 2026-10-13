// Read-only analysis of native PBAC expressions. No environment-specific rules.
import {performanceTypeHints} from '../lib/access-workspace/performance-types';
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const walk = (value, visit, path = []) => {
  if (!value || typeof value !== 'object') return;
  visit(value, path);
  for (const key of ['All','Any']) if (Array.isArray(value[key])) value[key].forEach((child,index) => walk(child,visit,[...path,key,index]));
  if (value.Not) walk(value.Not,visit,[...path,'Not']);
};
export const median = values => {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null;
};
export function validateSnapshot(snapshot) {
  const model = snapshot?.model;
  if (!model || !Array.isArray(model.policies) || !Array.isArray(model.roles)) throw new Error('Choose a Companion snapshot with model.policies and model.roles.');
  if (model.policies.length > 10000) throw new Error('Performance analysis supports up to 10,000 policies per snapshot.');
  if (model.policies.some(p => !p || typeof p.id !== 'string' || (p.rid != null && typeof p.rid !== 'string'))) throw new Error('Policy IDs and RIDs must be strings.');
  return snapshot;
}
export function analyze(snapshot) {
  validateSnapshot(snapshot);
  const enabled = snapshot.model.policies.filter(p => p.enabled === true);
  const rules = [], invalid = [], repeated = [], byStatement = new Map();
  for (const policy of enabled) {
    const statements = policy.content?.Statement;
    if (!Array.isArray(statements) || policy.valid === false) { invalid.push(policy); continue; }
    statements.forEach((statement, index) => {
      if (!statement || typeof statement !== 'object' || Array.isArray(statement)) { invalid.push(policy); return; }
      const rule = { key: `${policy.id}:${index}`, policy, index, statement, types: [], nested: 0 };
      rules.push(rule);
      const logic = { ...statement }; for (const key of ['comment', 'description', '_comment']) delete logic[key];
      const fingerprint = canonical(logic);
      const group = byStatement.get(fingerprint) || []; group.push(rule); byStatement.set(fingerprint, group);
      walk(statement.Resource, (node, path) => {
        for (const op of ['All', 'Any']) if (Array.isArray(node[op])) {
          const seen = new Map();
          node[op].forEach((child, childIndex) => {
            // Only pure comparisons: don't promise equivalence for stateful or recursive checks.
            if (!child?.Condition || Object.keys(child).some(k => !['Condition', 'comment', 'description', '_comment'].includes(k))) return;
            const key = canonical(child);
            if (seen.has(key)) repeated.push({ rule, op, path: [...path, op], first: seen.get(key), second: childIndex, expression: node });
            else seen.set(key, childIndex);
          });
        }
        if (node.HasAccessTo) rule.nested++;
        if (node.Condition) {
          const c = node.Condition;
          if (!path.includes('Not')) rule.types.push(...performanceTypeHints(c,snapshot.classes||{},snapshot.typeChildren));
        }
      });
    });
  }
  const duplicates = [...byStatement.values()].filter(group => group.length > 1);
  return { enabled, rules, invalid: [...new Set(invalid)], repeated, duplicates, nested: rules.filter(r => r.nested), disabled: snapshot.model.policies.length - enabled.length };
}
