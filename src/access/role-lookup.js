// Role-to-statement reverse lookup. A role receives statements that name it,
// statements that name one of its parent roles (inheritance), and statements
// for Everyone ("*"). Each entry says where it came from. Role checks inside
// a condition (HasRole) are listed separately: they do not grant the role anything.
import { pbacEffect, pbacActions, PBAC_ACTIONS } from './pbac-syntax';
import { statementSummary } from './statement-model';
import { NAMING_THIS_ROLE } from './access-terms';
import { isEveryoneRole, mergeEveryoneGroups } from './everyone-role';

const list = value => Array.isArray(value) ? value : value === undefined ? [] : [value];

/** Role and its parents, nearest first. Stops on a cycle. */
export function roleAncestry(roles, rid) {
  const byRid = new Map(roles.map(r => [r.rid, r])), chain = [], seen = new Set();
  for (let role = byRid.get(rid); role && !seen.has(role.rid); role = byRid.get(role.parent)) { seen.add(role.rid); chain.push(role); }
  return chain;
}

function mentionsRole(value, id) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(v => mentionsRole(v, id));
  return Object.entries(value).some(([key, v]) => key === 'Roles' && list(v).some(t => t === id || t === 'role:' + id) || typeof v === 'object' && mentionsRole(v, id));
}

/**
 * Statements that reach a role.
 * via: 'own' | 'parent' | 'everyone' | 'condition'; from: the role or label that grants it.
 */
export function roleStatements(model, rid, { policies = model.policies } = {}) {
  const chain = roleAncestry(model.roles, rid);
  if (!chain.length) return [];
  const [role, ...parents] = chain, entries = [];
  for (const policy of policies) {
    const statements = policy.content?.Statement;
    if (!Array.isArray(statements)) continue;
    statements.forEach((statement, index) => {
      if (!statement || typeof statement !== 'object') return;
      const subjects = statement.Subject === '*' ? ['*'] : list(statement.Subject);
      const base = { policy, index, statement, effect: pbacEffect(statement.Effect) ?? String(statement.Effect), enabled: policy.enabled !== false };
      if (subjects.includes('role:' + role.id)) entries.push({ ...base, via: 'own', from: role });
      else {
        const parent = parents.find(p => subjects.includes('role:' + p.id));
        if (parent) entries.push({ ...base, via: 'parent', from: parent });
        else if (subjects.includes('*')) entries.push({ ...base, via: 'everyone', from: { name: 'Everyone', id: '*' } });
        else if (mentionsRole(statement.Resource, role.id)) entries.push({ ...base, via: 'condition', from: role });
      }
    });
  }
  return entries;
}

/** Policies that mention a role, with their statements. Keeps policy order. */
export function rolePolicies(model, rid) {
  const groups = new Map();
  for (const entry of roleStatements(model, rid)) {
    if (!groups.has(entry.policy.rid)) groups.set(entry.policy.rid, { policy: entry.policy, entries: [] });
    groups.get(entry.policy.rid).entries.push(entry);
  }
  return [...groups.values()];
}

/** Words for where a statement comes from. Subject "*" is every user, marked so it is not
 * confused with a role that happens to be named Everyone. */
export function viaLabel(entry) {
  if (entry.via === 'own') return 'names this role';
  if (entry.via === 'parent') return 'via ' + entry.from.name;
  if (entry.via === 'everyone') return 'via Everyone (*)';
  return 'role checked in a condition';
}

export const OPERATIONS = PBAC_ACTIONS;

/** Operations a statement names, in C R U D order. "*" names all four. */
export function statementOperations(statement) {
  const granted = statement?.Action === '*' ? PBAC_ACTIONS : pbacActions(statement?.Action);
  return PBAC_ACTIONS.filter(a => granted.includes(a));
}

/** Why a statement grants nothing to the role, in words; '' when it grants.
 * Same rule as the matrix: a disabled or invalid policy takes no part. */
export function grantBlock(e) {
  if (!e.policy.enabled) return 'Disabled';
  if (e.policy.valid === false) return 'Invalid';
  if (e.effect === 'Deny') return 'Deny';
  if (e.effect !== 'Allow') return 'Not Allow';
  if (e.via === 'condition') return 'Condition';
  return '';
}

/**
 * "What it grants" on the role page: one group per origin, in reading order:
 * statements that name the role, then each parent role (nearest first), then
 * Subject "*", then statements that only check the role in a condition.
 * Each group rolls up the operations of its rows: an operation is in the
 * roll-up when ANY counted row grants it. Only rows that grant to the role
 * count: Allow, in an enabled and valid policy, naming the role (or a parent,
 * or everyone). A stored Deny (ignored by the server), an unknown effect, a
 * disabled or invalid policy and a condition check never count.
 * Inherited and Everyone groups are read-only here.
 */
export function roleGrantGroups(model, rid) {
  const chain = roleAncestry(model.roles, rid), entries = roleStatements(model, rid), groups = [];
  const add = (key, origin, title, from, list) => {
    if (!list.length) return;
    const rows = list.map(e => {
      const block = grantBlock(e);
      return { ...e, ops: statementOperations(e.statement), block, counted: !block, unconditional: statementSummary(e.statement).resource.text === 'all objects' };
    });
    groups.push({
      key, origin, title, from, readOnly: origin === 'parent' || origin === 'everyone', rows,
      rollup: PBAC_ACTIONS.filter(op => rows.some(r => r.counted && r.ops.includes(op))),
      statements: rows.length, policies: new Set(rows.map(r => r.policy.rid)).size,
      // What the group label counts: like the section header, granting rows apart from the rest.
      totals: grantTotals([{ rows }]),
    });
  };
  add('own', 'own', NAMING_THIS_ROLE, chain[0], entries.filter(e => e.via === 'own'));
  for (const parent of chain.slice(1)) add('parent:' + parent.rid, 'parent', 'Inherited from ' + parent.name, parent, entries.filter(e => e.via === 'parent' && e.from.rid === parent.rid));
  add('everyone', 'everyone', 'Granted to everyone (*)', null, entries.filter(e => e.via === 'everyone'));
  add('condition', 'condition', 'Checked in a condition', chain[0], entries.filter(e => e.via === 'condition'));
  return isEveryoneRole(chain[0]) ? mergeEveryoneGroups(groups) : groups;
}

/** Totals for the section header: statements that grant to the role, their
 *  distinct policies, and how many listed rows grant nothing. */
export function grantTotals(groups) {
  const rows = groups.flatMap(g => g.rows), counted = rows.filter(r => r.counted);
  return { statements: counted.length, policies: new Set(counted.map(r => r.policy.rid)).size, other: rows.length - counted.length };
}

/** What the role may do over all origins: operations some statement grants on
 *  every object, and operations granted only on some objects (under a condition). */
export function roleAccess(groups) {
  const rows = groups.flatMap(g => g.rows).filter(r => r.counted);
  const always = PBAC_ACTIONS.filter(op => rows.some(r => r.unconditional && r.ops.includes(op)));
  const some = PBAC_ACTIONS.filter(op => !always.includes(op) && rows.some(r => r.ops.includes(op)));
  return { always, some, none: PBAC_ACTIONS.filter(op => !always.includes(op) && !some.includes(op)) };
}
