// BMP 5.6.10: ResourceExpressionMapping, ComparisonFactory, TokenFactory,
// JsonPolicyDeserializer, HasRoleFactory and HasAccessToFactory. Keep syntax
// recognition separate from environment-dependent type/property/ID validation.
export const PBAC_EXPRESSIONS = new Set(['All', 'Any', 'Condition', 'HasRole', 'HasAccessTo']);
export const PBAC_COMPARISONS = new Set([
  '=', 'Equal', '!=', 'NotEqual', '~', 'Contains', '!~', 'NotContains',
  'ContainsAll', 'NotContainsAll', 'ContainsAny', 'NotContainsAny',
  'ExactTypeOf', 'Empty', 'NotEmpty'
]);
export type PbacAction = 'Create' | 'Read' | 'Update' | 'Delete';
export const PBAC_ACTIONS: readonly PbacAction[] = ['Create', 'Read', 'Update', 'Delete'];
const enumValue = <T extends string>(choices: readonly T[], value: unknown): T | undefined => typeof value === 'string'
  ? choices.find(choice => choice.toUpperCase() === value.toUpperCase()) : undefined;
export const pbacAction = (value: unknown) => enumValue(PBAC_ACTIONS, value);
// The deserializer accepts Allow and Deny, but the engine is grant-only: it only
// checks whether a statement's effect is Allow. A matching Deny grants nothing
// and blocks nothing, so Companion never offers Deny for new statements.
export const pbacEffect = (value: unknown) => enumValue(['Allow', 'Deny'], value);
export { DENY_IGNORED } from '../lib/access-wording';
export const pbacGrouping = (value: unknown) => enumValue(['All', 'Any'], value);
export const isPBACAction = (value: unknown) => pbacAction(value) !== undefined;
export const isPBACEffect = (value: unknown) => pbacEffect(value) !== undefined;
export const isPBACGrouping = (value: unknown) => pbacGrouping(value) !== undefined;
export const pbacActions = (value: unknown): PbacAction[] => [...new Set((Array.isArray(value) ? value : [value]).map(pbacAction).filter((action): action is PbacAction => Boolean(action)))];
// Editing one action preserves every untouched source token, including its casing.
export function togglePBACAction(value: unknown, action: PbacAction, checked: boolean): unknown[] {
  const list = Array.isArray(value) ? [...value] : value === undefined ? [] : [value];
  if (!checked) return list.filter(item => pbacAction(item) !== action);
  return list.some(item => pbacAction(item) === action) ? list : [...list, action];
}
export const activePBACExpressions = (node: Record<string, unknown>) => Object.keys(node).filter(key => PBAC_EXPRESSIONS.has(key) && node[key] != null);
export const isPBACLeft = (value: unknown): value is string => typeof value === 'string' && (value === 'resource' || /^(resource|new)\..+/.test(value));
export const isPBACReference = (value: unknown): value is string => typeof value === 'string' && /^(resource|new|reversed)\..+/.test(value);
export const isPBACSubject = (value: unknown): value is string => typeof value === 'string' && /^(role|user):.+/.test(value);

// TokenFactory dispatches the complete operand, before dispatching Comparison
// (including Empty / NotEmpty). A mixed array is never partially a reference list.
// Existence of types, models, properties and business IDs is checked by BMP.
const objectReference = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z]+:[^\r\n\u0085\u2028\u2029]*$(?![\s\S])/.test(value);
export type PbacRightKind = 'literal' | 'user' | 'objects' | 'types' | 'models';
export function classifyPBACRight(left: unknown, right: unknown): { kind: PbacRightKind; problem?: string } {
  if (right === 'user') return { kind: 'user' };
  const values = Array.isArray(right) ? right : [right];
  let kind: PbacRightKind = 'literal';
  if (objectReference(right) || Array.isArray(right) && right.length > 0 && right.every(objectReference)) kind = 'objects';
  else if (typeof left === 'string' && ['resource.type', 'new.type'].includes(left.toLowerCase())) kind = 'types';
  else if (left === 'resource') kind = 'objects';
  else if (left === 'resource.model') kind = 'models';
  if (kind === 'objects' && values.some(value => !objectReference(value) || !value.split(':')[1]))
    return { kind, problem: 'Use ObjectType:ObjectId or a list of those references.' };
  if (['types', 'models'].includes(kind) && values.some(value => typeof value !== 'string'))
    return { kind, problem: `Use a ${kind === 'types' ? 'type' : 'model'} name or a list of names.` };
  return { kind };
}
