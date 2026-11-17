// "Add statement" on a role page: choose the policy, then add a statement whose
// Who is that role. Policies that already name the role come first, then every
// other policy, then "New policy…". The new statement grants nothing until the
// user picks what it can do; it is unsaved until the review.
import type { PolicyJson } from './schema-model';
import { NAMING_THIS_ROLE } from './access-terms';

export const NEW_POLICY = '\u0000new-policy';
const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
interface PolicyRecord { rid: string; id: string; name: string; parent?: string; content?: PolicyJson }
interface RoleRecord { id: string; name: string }
export interface PolicyChoice { rid: string; label: string; secondary: string; group: string; icon: string; depth: number }

const subjects = (statement: PolicyJson): unknown[] => statement?.Subject === '*' ? ['*'] : Array.isArray(statement?.Subject) ? statement.Subject : [statement?.Subject];
/** Does any statement of the policy name the role in its Who? */
export const namesRole = (policy: PolicyRecord, roleId: string) =>
  Array.isArray(policy.content?.Statement) && policy.content.Statement.some((s: PolicyJson) => subjects(s).includes('role:' + roleId));

/** Picker rows, grouped. `where` names a policy's folder for the secondary text. */
export function policyChoices(policies: PolicyRecord[], role: RoleRecord, where: (p: PolicyRecord) => string = () => ''): PolicyChoice[] {
  const row = (p: PolicyRecord, group: string): PolicyChoice => ({ rid: p.rid, label: p.name.trim(), secondary: [p.id, where(p)].filter(Boolean).join(' · '), group, icon: 'policy', depth: 0 });
  // By the name as shown: stored names may start with spaces, and case and digits sort as a reader expects.
  const byName = (a: PolicyRecord, b: PolicyRecord) => NAME_ORDER.compare(a.name.trim(), b.name.trim()) || a.id.localeCompare(b.id);
  const naming = policies.filter(p => namesRole(p, role.id)).sort(byName), rest = policies.filter(p => !namesRole(p, role.id)).sort(byName);
  return [...naming.map(p => row(p, NAMING_THIS_ROLE)), ...rest.map(p => row(p, 'All policies')),
    { rid: NEW_POLICY, label: 'New policy…', secondary: 'Starts with a statement for ' + role.name, group: 'New', icon: 'plus', depth: 0 }];
}

/** The policy content with one more statement whose Who is the role, and that statement's index. */
export function withRoleStatement(content: PolicyJson, roleId: string): { content: PolicyJson; index: number } {
  const statements = Array.isArray(content?.Statement) ? content.Statement : [];
  const statement = { Subject: ['role:' + roleId], Effect: 'Allow', Action: [], Resource: { All: [] } };
  return { content: { ...(content ?? { Version: '1.0' }), Statement: [...statements, statement] }, index: statements.length };
}
