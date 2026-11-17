// The built-in Everyone role: every user holds it, so its page does not ask who
// holds it, and statements naming the role and statements for every user ("*")
// read as one group. Other roles are unchanged.
import { PBAC_ACTIONS } from './pbac-syntax';
import { escapeHtml as esc } from '../lib/escape';

interface Role { id: string; name: string; parent?: string }
interface Row { policy: { rid: string }; counted: boolean; ops: string[] }
interface Group { key: string; origin: string; title: string; readOnly: boolean; rows: Row[]; [field: string]: unknown }

export const EVERY_USER_HOLDS = 'Every user holds this role.';
export const ALL_USERS_GROUP = 'Granted to every user';

/** The built-in audience: a top-level role named or identified as Everyone. */
export const isEveryoneRole = (role?: Role | null) => !!role && !role.parent && (/^(role_?)?everyone$/i.test(role.id) || /^everyone$/i.test(role.name));

/** One group for the Everyone role: its own statements and the "*" statements together. */
export function mergeEveryoneGroups<G extends Group>(groups: G[]): G[] {
  const own = groups.find(g => g.origin === 'own'), all = groups.find(g => g.origin === 'everyone');
  if (!own && !all) return groups;
  const rows = [...(own?.rows ?? []), ...(all?.rows ?? [])], counted = rows.filter(r => r.counted);
  const merged = { ...(own ?? all) as G, key: 'all-users', origin: 'all-users', title: ALL_USERS_GROUP, readOnly: false, from: null, rows,
    rollup: PBAC_ACTIONS.filter(op => counted.some(r => r.ops.includes(op))),
    statements: rows.length, policies: new Set(rows.map(r => r.policy.rid)).size,
    totals: { statements: counted.length, policies: new Set(counted.map(r => r.policy.rid)).size, other: rows.length - counted.length } };
  const rest = groups.filter(g => g !== own && g !== all);
  return [merged, ...rest];
}

/** "Who has this role" for the Everyone role: no holders to add. */
export function everyoneWhoHtml(): string {
  return `<section class="rp-sec" data-role-section="who" tabindex="-1" aria-labelledby="role-who-h"><div class="rp-sh"><h2 id="role-who-h">Who has this role</h2><span class="rp-cnt">Every user</span></div>` +
    `<p class="rp-empty rp-everyone">${esc(EVERY_USER_HOLDS)} It needs no field assignment and no user or group.</p></section>`;
}
