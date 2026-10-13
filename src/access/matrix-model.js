import { PBAC_ACTIONS, pbacActions, pbacEffect } from './pbac-syntax.js';
import { evaluateMatrixExpression, coverageStatus, matrixTypeGraph, DEFINITE, CONDITIONAL, UNRESOLVED } from './matrix-evaluation.js';
export { typeMatch, collectMatrixReferences } from './matrix-evaluation.js';
const list = value => Array.isArray(value) ? value : [value];

export function matrixTypeGroup(type) {
  if (['Scorecard', 'Organisation'].includes(type)) return 'Structure';
  if (/^Ce[A-Z]/.test(type)) return 'Enterprise objects';
  if (/^(ActionButton|InputView|ButtonInput|Tab|Container|Widget|Page|Layout|.*View|.*Widget|.*Input|.*Table)$/.test(type)) return 'Interface objects';
  return 'Other types';
}
// Four bits per evidence class (CRUD), plus supported/unresolved Deny flags.
// Summaries contain no duplicated rules; details are resolved only on inspection.
const DENY = 1 << 12, UNRESOLVED_DENY = 1 << 13, summaries = new Map();
function summaryFrom(bits) {
  if (summaries.has(bits)) return summaries.get(bits);
  const actions = PBAC_ACTIONS.filter((_, i) => bits & (1 << i | 1 << (i + 4)));
  const conditionalActions = PBAC_ACTIONS.filter((_, i) => !(bits & 1 << i) && bits & 1 << (i + 4));
  const unresolvedActions = PBAC_ACTIONS.filter((_, i) => bits & 1 << (i + 8));
  const result = { actions, conditionalActions, conditional: !!conditionalActions.length,
    unresolvedActions, unresolved: !!unresolvedActions.length || !!(bits & UNRESOLVED_DENY),
    deny: !!(bits & DENY), hasCoverage: !!actions.length || !!(bits & DENY) };
  summaries.set(bits, result); return result;
}
function bitsFor(status, effect, i) {
  if (!status) return 0;
  if (effect === 'Deny') return status === UNRESOLVED ? UNRESOLVED_DENY : DENY;
  return 1 << (i + (status === DEFINITE ? 0 : status === CONDITIONAL ? 4 : 8));
}
function hasActorPredicate(v) {
  return !!v && typeof v === 'object' && (Object.hasOwn(v, 'HasRole') || Object.values(v).some(hasActorPredicate));
}
function actorSignature(v, roleIds) {
  if (!v || typeof v !== 'object') return '';
  if (v.HasRole) return Array.isArray(v.HasRole.Roles) && v.HasRole.Roles.length ? String(v.HasRole.Roles.some(id => roleIds?.has(id))) : '?';
  return Object.values(v).map(child => actorSignature(child, roleIds)).join('');
}

/** Immutable saved-snapshot + metadata index. Share type facts across roles,
 * keep actor-dependent expressions separate, and bound inspector allocations. */
export function createMatrixIndex(model, classes, fallbackChildren = {}, metadata) {
  const children = matrixTypeGraph(metadata, fallbackChildren);
  const rules = [], types = new Set(Object.keys(classes)), bySubject = new Map(), everyone = [];
  if (metadata) for (const t of children.Identifiable ?? []) if (metadata.types[t]?.concrete) types.add(t);
  function collectTypes(v) {
    if (!v || typeof v !== 'object') return;
    if (['resource.type', 'new.type'].includes(v.Left)) for (const t of list(v.Right))
      if (typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t)) types.add(t);
    Object.values(v).forEach(collectTypes);
  }
  for (const policy of model.policies) {
    if (!policy.enabled || policy.valid === false || !Array.isArray(policy.content?.Statement)) continue;
    policy.content.Statement.forEach((statement, index) => {
      collectTypes(statement.Resource);
      const actions = statement.Action === '*' ? PBAC_ACTIONS : pbacActions(statement.Action);
      if (!actions.length || !pbacEffect(statement.Effect)) return;
      const rule = { key: policy.rid + ':' + index, policy, index, statement, actions, effect: pbacEffect(statement.Effect), actorDependent: hasActorPredicate(statement.Resource) };
      rules.push(rule);
      if (statement.Subject === '*') everyone.push(rule);
      else for (const subject of list(statement.Subject)) if (typeof subject === 'string' && subject.startsWith('role:')) {
        if (!bySubject.has(subject.slice(5))) bySubject.set(subject.slice(5), []);
        bySubject.get(subject.slice(5)).push(rule);
      }
    });
  }
  const groups = ['Structure', 'Enterprise objects', 'Interface objects', 'Other types'];
  const columns = [...types].filter(t => !metadata?.types[t] || metadata.types[t].concrete)
    .map(id => ({ id, group: matrixTypeGroup(id), width: Math.max(80, id.length * 6.5 + 18) }))
    .sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.id.localeCompare(b.id));
  const roles = model.roles, roleMap = new Map(roles.map(r => [r.rid, r]));
  const columnAt = new Map(columns.map((c, i) => [c.id, i])), facts = new Map(), rowFacts = new Map(), roleContexts = new Map();
  const evaluate = (rule, type, action, roleIds) => evaluateMatrixExpression(rule.statement.Resource, { type, action, children, metadata, roleIds });
  function compile(rule, roleIds) {
    const signature = rule.actorDependent ? actorSignature(rule.statement.Resource, roleIds) : '';
    if (!facts.has(rule)) facts.set(rule, new Map());
    const variants = facts.get(rule);
    if (variants.has(signature)) return variants.get(signature);
    const result = new Uint16Array(columns.length);
    columns.forEach((column, i) => {
      for (const action of rule.actions) {
        const evidence = evaluate(rule, column.id, action, roleIds), status = coverageStatus(evidence), at = PBAC_ACTIONS.indexOf(action);
        result[i] |= bitsFor(status, rule.effect, at);
        if (status === CONDITIONAL && evidence.unresolvedReasons?.length) result[i] |= bitsFor(UNRESOLVED, rule.effect, at);
      }
    });
    variants.set(signature, result);
    return result;
  }
  const merge = (target, source) => { for (let i = 0; i < source.length; i++) target[i] |= source[i]; };
  let everyoneFacts;
  function roleContext(rid) {
    if (roleContexts.has(rid)) return roleContexts.get(rid);
    const ids = new Set(), visited = new Set(), candidates = new Set(everyone);
    for (let role = roleMap.get(rid); role && !visited.has(role.rid); role = roleMap.get(role.parent)) {
      visited.add(role.rid); ids.add(role.id);
      for (const rule of bySubject.get(role.id) ?? []) candidates.add(rule);
    }
    const result = { ids, candidates }; roleContexts.set(rid, result); return result;
  }
  function row(rid) {
    if (rowFacts.has(rid)) return rowFacts.get(rid);
    if (!everyoneFacts) {
      everyoneFacts = new Uint16Array(columns.length);
      for (const rule of everyone) if (!rule.actorDependent) merge(everyoneFacts, compile(rule));
    }
    const result = everyoneFacts.slice(), { ids, candidates } = roleContext(rid);
    for (const rule of candidates) if (rule.actorDependent || rule.statement.Subject !== '*') merge(result, compile(rule, ids));
    rowFacts.set(rid, result); return result;
  }
  const summary = (rid, type) => summaryFrom(row(rid)[columnAt.get(type)] ?? 0);
  const inspected = new Map();
  function cell(rid, type) {
    const key = rid + '|' + type;
    if (inspected.has(key)) return inspected.get(key);
    const { ids, candidates } = roleContext(rid), entries = [], unresolvedRules = [];
    for (const rule of candidates) {
      const evidence = rule.actions.map(action => {
        const result = evaluate(rule, type, action, ids);
        return { action, status: coverageStatus(result), reasons: result.reasons, unresolvedReasons:result.unresolvedReasons ?? [] };
      });
      const supported = evidence.filter(e => e.status === DEFINITE || e.status === CONDITIONAL);
      const unresolved = evidence.filter(e => e.status === UNRESOLVED || e.status === CONDITIONAL && e.unresolvedReasons.length);
      if (!supported.length && !unresolved.length) continue;
      const entry = { ...rule, actions:supported.map(e=>e.action),
        conditionalActions:supported.filter(e=>e.status===CONDITIONAL).map(e=>e.action),
        conditional:supported.some(e=>e.status===CONDITIONAL),
        unresolved:!supported.length, unresolvedActions:unresolved.map(e=>e.action),
        reasons:[...new Set(supported.flatMap(e=>e.reasons))],
        unresolvedReasons:[...new Set(unresolved.flatMap(e=>e.status===UNRESOLVED?e.reasons:e.unresolvedReasons))] };
      if (supported.length) entries.push(entry);
      if (unresolved.length) unresolvedRules.push(entry);
    }
    const result = { ...summary(rid, type), rules: entries, unresolvedRules };
    if (inspected.size >= 32) inspected.delete(inspected.keys().next().value);
    inspected.set(key, result); return result;
  }
  return { roles, columns, cell, summary, rules };
}

const projections = new WeakMap();
export function filterMatrix(index, state) {
  const projectionKey = JSON.stringify([state.roleQ, state.typeQ, state.sections, state.filters, state.hideEmpty, state.sort, !!state.unresolved]);
  const cached = projections.get(index);
  if (cached?.key === projectionKey) return cached.value;
  const cell = index.summary ?? index.cell;
  const includeUnresolved = !!state.unresolved;
  let rows = index.roles.filter(r => (r.name + ' ' + r.id).toLowerCase().includes((state.roleQ || '').toLowerCase()));
  const sections = state.sections ?? [];
  let cols = index.columns.filter(t => (!sections.length || sections.includes(t.group)) && t.id.toLowerCase().includes((state.typeQ || '').toLowerCase()));
  const filters = state.filters ?? [];
  const matches = (rid, type) => !filters.length || cell(rid, type).actions.some(a => filters.includes(a)) ||
    includeUnresolved && (cell(rid, type).unresolvedActions ?? []).some(a => filters.includes(a));
  const visible = (rid, type) => {
    const value = cell(rid, type);
    return matches(rid, type) && ((value.hasCoverage ?? value.rules?.length) || includeUnresolved && value.unresolved);
  };
  if (state.hideEmpty || filters.length) {
    cols = cols.filter(t => rows.some(r => visible(r.rid, t.id)));
    rows = rows.filter(r => cols.some(t => visible(r.rid, t.id)));
  }
  const coverage = new Map(state.sort === 'coverage' ? rows.map(r => [r.rid, cols.reduce((sum, t) => sum + (matches(r.rid, t.id) ? cell(r.rid, t.id).actions.length : 0), 0)]) : []);
  rows.sort((a, b) => (coverage.get(b.rid) ?? 0) - (coverage.get(a.rid) ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const value = { rows, cols, matches };
  projections.set(index, { key:projectionKey, value });
  return value;
}
