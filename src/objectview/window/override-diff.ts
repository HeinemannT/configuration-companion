/**
 * "overrides template": shown only where it says something. The server's
 * `overridden` set of a linked object lists almost every stored property
 * (audit fields included), so the chip is decided by comparing the value
 * with the linked template's value for the same property. Pure; no DOM.
 */
import type { FullObject, PropValue } from '../../lib/object-read';
import { templateRidOf } from './draft';

/** Audit, identity and placement fields: an instance and its template
 *  differ in them by nature (own ID, own path, the link itself), so they
 *  never mean an override. Keys starting with `_` are the server's own. */
const NEVER = new RegExp([
  '^_',
  '^(id|rid|name|simpleName|businessId|templateBusinessId|className|type|typeKey|uuid|version|ownership|refresh|systemObject)$',
  '^(fullPath|path|model|link|linkedTo|templateLinkedTo|parent|container|sortIndex|profileMappings)$',
  '^(created|creat(ion|ed)|lastModified|modified|changed|updated)',
  'Accessors$',
].join('|'), 'i');

export function isAuditOrIdentity(key: string): boolean {
  return NEVER.test(key);
}

export type OverrideState =
  /** Not linked to a template, or nothing to compare: no chips. */
  | { kind: 'none' }
  /** The template is being read: no chips yet. */
  | { kind: 'loading'; templateRid: string }
  /** The template could not be read: no chips, one quiet line. */
  | { kind: 'error'; templateRid: string; error: string }
  | { kind: 'ready'; templateRid: string; template: FullObject };

/** What the chip can say for `obj`, given the template reads so far. */
export function overrideState(
  obj: FullObject,
  templates: Readonly<Record<string, { obj?: FullObject; loading?: boolean; error?: string }>>,
): OverrideState {
  const templateRid = templateRidOf(obj);
  if (!templateRid || templateRid === obj.rid) return { kind: 'none' };
  const t = templates[templateRid];
  if (t?.obj) return { kind: 'ready', templateRid, template: t.obj };
  if (t?.error) return { kind: 'error', templateRid, error: t.error };
  return { kind: 'loading', templateRid };
}

function sameValue(a: PropValue | undefined, b: PropValue | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.kind === 'boolean' || b.kind === 'boolean') return (a.bool ?? a.text === 'true') === (b.bool ?? b.text === 'true');
  if (a.kind === 'list' || b.kind === 'list') return (a.items ?? []).join('\u0000') === (b.items ?? []).join('\u0000');
  return a.text === b.text && (a.text !== '' || (a.cls ?? '') === (b.cls ?? ''));
}

function sameRefs(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...(a ?? [])].sort();
  const y = [...(b ?? [])].sort();
  return x.length === y.length && x.every((r, i) => r === y[i]);
}

/** Whether `key` of `obj` really differs from its template's value: a
 *  property (`ref` false) or a reference role (`ref` true). Never for audit
 *  or identity fields, never without a template read. */
export function overrides(obj: FullObject, key: string, state: OverrideState, ref = false): boolean {
  if (state.kind !== 'ready' || isAuditOrIdentity(key)) return false;
  const t = state.template;
  if (ref) {
    if (!(key in obj.references) && !(key in t.references)) return false;
    return !sameRefs(obj.references[key], t.references[key]);
  }
  if (!(key in obj.props) && !(key in t.props)) return false;
  return !sameValue(obj.props[key], t.props[key]);
}

/** Whether the comparison was wanted but could not be made. */
export function compareFailed(state: OverrideState): boolean {
  return state.kind === 'error';
}
