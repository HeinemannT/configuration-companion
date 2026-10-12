import { PBAC_ACTIONS, pbacActions, pbacEffect } from './pbac-syntax.js';

const list = value => Array.isArray(value) ? value : [value];
const UNKNOWN = null;

// Partial evaluation, not an access decision. Resolve static type predicates
// with the server subtype catalogue. Dynamic operands and unknown types remain
// conditional; never infer effective access without an engine trace.
export function typeMatch(expression, type, action, children = {}) {
  if (expression === '*') return true;
  if (!expression || typeof expression !== 'object') return UNKNOWN;
  if (Array.isArray(expression.All)) {
    const values = expression.All.map(e => typeMatch(e, type, action, children));
    return values.includes(false) ? false : values.every(v => v === true) ? true : UNKNOWN;
  }
  if (Array.isArray(expression.Any)) {
    const values = expression.Any.map(e => typeMatch(e, type, action, children));
    return values.includes(true) ? true : values.every(v => v === false) ? false : UNKNOWN;
  }
  const c = expression.Condition;
  if(!c)return UNKNOWN;
  const left = typeof c.Left === 'string' ? c.Left : '';
  const absent = action==='Create' && (left==='resource'||left.startsWith('resource.')) ||
    ['Read','Delete'].includes(action) && left.startsWith('new.');
  if(absent) {
    if(['Empty','!=','NotEqual','!~','NotContains','NotContainsAny','NotContainsAll'].includes(c.Comparison))return true;
    if(['NotEmpty','=','Equal','~','Contains','ContainsAny','ContainsAll','ExactTypeOf'].includes(c.Comparison))return false;
    return UNKNOWN;
  }
  if (!['resource.type','new.type'].includes(c.Left)) return UNKNOWN;
  const values = list(c.Right);
  if (!values.length || values.some(v => typeof v !== 'string' || /[:.]/.test(v))) return UNKNOWN;
  const hit = values.includes(type);
  if (c.Comparison === 'ExactTypeOf') return Array.isArray(c.Right) ? false : hit;
  // BMP Equal(TypeKey, TypeKey) includes subtypes and unwraps singleton lists.
  const matches = values.map(v => v === type ? true : Object.hasOwn(children,v) ? children[v].includes(type) : UNKNOWN);
  const any = matches.includes(true) ? true : matches.every(v=>v===false) ? false : UNKNOWN;
  const all = matches.includes(false) ? false : matches.every(v=>v===true) ? true : UNKNOWN;
  const invert = value => value === null ? null : !value;
  if (['=', 'Equal'].includes(c.Comparison)) return values.length === 1 ? any : false;
  if (['!=', 'NotEqual'].includes(c.Comparison)) return values.length === 1 ? invert(any) : true;
  if (['ContainsAny'].includes(c.Comparison)) return any;
  if (['~', 'Contains'].includes(c.Comparison)) return Array.isArray(c.Right) ? any : false;
  if (c.Comparison === 'ContainsAll') return all;
  if (['NotContainsAny'].includes(c.Comparison)) return invert(any);
  if (['!~', 'NotContains'].includes(c.Comparison)) return Array.isArray(c.Right) ? invert(any) : true;
  if (c.Comparison === 'NotContainsAll') return invert(all);
  return UNKNOWN;
}

export function matrixTypeGroup(type) {
  if (['Scorecard', 'Organisation'].includes(type)) return 'Structure';
  if (/^Ce[A-Z]/.test(type)) return 'Enterprise objects';
  if (/^(ActionButton|InputView|ButtonInput|Tab|Container|Widget|Page|Layout|.*View|.*Widget|.*Input)$/.test(type)) return 'Interface objects';
  return 'Other types';
}

/** One immutable index per saved snapshot. No object/principal queries and no
 * eager roles × types × statements allocation. Cell results are bounded by the
 * loaded role/type catalogue and cached for filtering and inspection. */
export function createMatrixIndex(model, classes, children = {}) {
  const rules = [], types = new Set(Object.keys(classes)), bySubject = new Map(), everyone = [];
  function collectTypes(value) {
    if (!value || typeof value !== 'object') return;
    if (['resource.type', 'new.type'].includes(value.Left)) for (const t of list(value.Right))
      if (typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t)) types.add(t);
    for (const child of Object.values(value)) if (typeof child === 'object') collectTypes(child);
  }
  for (const policy of model.policies) {
    if (!policy.enabled || policy.valid === false || !Array.isArray(policy.content?.Statement)) continue;
    policy.content.Statement.forEach((statement, index) => {
      collectTypes(statement.Resource);
      const actions = statement.Action === '*' ? PBAC_ACTIONS : pbacActions(statement.Action);
      if (!actions.length || !pbacEffect(statement.Effect)) return;
      const rule = { key: policy.rid + ':' + index, policy, index, statement, actions, effect: pbacEffect(statement.Effect) };
      rules.push(rule);
      if (statement.Subject === '*') everyone.push(rule);
      else for (const subject of list(statement.Subject)) if (typeof subject === 'string' && subject.startsWith('role:')) {
        if (!bySubject.has(subject.slice(5))) bySubject.set(subject.slice(5), []);
        bySubject.get(subject.slice(5)).push(rule);
      }
    });
  }
  const groups = ['Structure', 'Enterprise objects', 'Interface objects', 'Other types'];
  const columns = [...types].map(id => ({ id, group: matrixTypeGroup(id), width: Math.max(80, id.length * 6.5 + 18) }))
    .sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.id.localeCompare(b.id));
  const roles = model.roles, roleMap = new Map(roles.map(r => [r.rid, r])), cache = new Map();
  function cell(rid, type) {
    const key = rid + '|' + type;
    if (cache.has(key)) return cache.get(key);
    // BMP Role.isA includes ancestors. A child role matches parent subjects.
    const candidates = [...everyone], visited = new Set();
    for (let role = roleMap.get(rid); role && !visited.has(role.rid); role = roleMap.get(role.parent)) {
      visited.add(role.rid);
      candidates.push(...(bySubject.get(role.id) ?? []));
    }
    const entries = [];
    for (const rule of new Set(candidates)) {
      const matches = rule.actions.map(action => ({ action, match: typeMatch(rule.statement.Resource, type, action, children) })).filter(r => r.match !== false);
      if (matches.length) entries.push({ ...rule, actions: matches.map(r => r.action), conditional: matches.some(r => r.match !== true) });
    }
    const allows = entries.filter(r => r.effect === 'Allow');
    const actions = PBAC_ACTIONS.filter(a => allows.some(r => r.actions.includes(a)));
    const result = { rules: entries, actions, conditional: allows.some(r => r.conditional), deny: entries.some(r => r.effect === 'Deny') };
    cache.set(key, result);
    return result;
  }
  return { roles, columns, cell, rules };
}

export function filterMatrix(index, state) {
  let rows = index.roles.filter(r => (r.name + ' ' + r.id).toLowerCase().includes((state.roleQ || '').toLowerCase()));
  const sections = state.sections ?? [];
  let cols = index.columns.filter(t => (!sections.length || sections.includes(t.group)) && t.id.toLowerCase().includes((state.typeQ || '').toLowerCase()));
  const filters = state.filters ?? [];
  const matches = (rid, type) => !filters.length || index.cell(rid, type).actions.some(a => filters.includes(a));
  if (state.hideEmpty || filters.length) {
    cols = cols.filter(t => rows.some(r => matches(r.rid, t.id) && index.cell(r.rid, t.id).rules.length));
    rows = rows.filter(r => cols.some(t => matches(r.rid, t.id) && index.cell(r.rid, t.id).rules.length));
  }
  const coverage = new Map(state.sort === 'coverage' ? rows.map(r => [r.rid, cols.reduce((sum, t) => sum + (matches(r.rid, t.id) ? index.cell(r.rid, t.id).actions.length : 0), 0)]) : []);
  rows.sort((a, b) => (coverage.get(b.rid) ?? 0) - (coverage.get(a.rid) ?? 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { rows, cols, matches };
}
