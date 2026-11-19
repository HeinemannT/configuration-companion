/**
 * Full object read — typed view of one `IntegrationGetObjectCommand` response.
 *
 * Keeps what the object window (and the pane's override read) needs:
 *  - every returned property with a small value kind derived from the boxed
 *    Java class (the class is the only cheap type information we get);
 *  - the `references` map as role → rid strings (rids stay strings: they are
 *    Java longs and exceed Number.MAX_SAFE_INTEGER);
 *  - `overridden` (template-linked instances).
 *
 * Pure: no chrome.*, no transport. The output is JSON-safe so it can cross
 * chrome.runtime messaging unchanged.
 */

import { JavaEnum } from './java-serial';
import { SCRIPT_PROPS } from './types';
import { fileLinkPropsOf } from './file-link-props';

export type ValueKind =
  | 'text' | 'html' | 'number' | 'boolean' | 'enum' | 'code' | 'time' | 'list' | 'unknown';

export interface PropValue {
  kind: ValueKind;
  /** Display text. Empty string means "no value". */
  text: string;
  /** Primitive value for booleans and safe numbers. */
  bool?: boolean;
  num?: number;
  /** Simple enum class name (e.g. `ButtonInputType`) when the read kept it. */
  enumClass?: string;
  /** List items as display strings. */
  items?: string[];
  /** Short Java class name of an `unknown` or `code` value (e.g.
   *  `ConditionGroupList`, `CorpoExtendedExpression`). */
  cls?: string;
}

export interface FullObject {
  rid: string;
  type: string;
  name: string;
  businessId: string;
  props: Record<string, PropValue>;
  /** role → rid strings. Role names are BMP's (`parent`, `inputSet`, …) or
   *  the numeric rid of a reference-typed custom property definition. */
  references: Record<string, string[]>;
  overridden: string[];
  /** Read with the row facts only (object-row-facts.ts): enough for a
   *  tree row and its markers, never for the detail pane. */
  lite?: boolean;
  /** Light object whose markers could not be read (only its name, type and
   *  ID are known): the row shows its markers as unknown. */
  factsUnknown?: boolean;
}

/** The batched read's answer for a rid BMP returned nothing for: the
 *  object does not exist (deleted, or a RID of another server). */
export const OBJECT_NO_DATA = 'Object read returned no data';

/** Lightweight identity used for relation targets and breadcrumbs. */
export interface ObjectSummary {
  rid: string;
  type: string;
  name: string;
  businessId: string;
}

export function summarize(obj: FullObject): ObjectSummary {
  return { rid: obj.rid, type: obj.type, name: obj.name, businessId: obj.businessId };
}

/** Property names that hold Extended Code even when the read returns them as
 *  plain strings (unset expressions come back as ''). */
export function isCodePropName(name: string): boolean {
  return name === 'expression' || /[a-z]Expression$/.test(name);
}

/** Properties whose save goes through Extended Code (`_o.change(p := "…")`)
 *  whatever the caller knows about the value: the script props of
 *  Custom Visualization and the TextElement HTML bodies. */
const EC_SAVE_PROPS = new Set<string>([...SCRIPT_PROPS, 'text', 'longText']);

/** True when a property name is an Extended Code expression slot
 *  (`expression`, `afterExpression`, `showExpression`, …). The gate switches
 *  `useShowExpression` / `useEnableExpression` are booleans and excluded. */
export function isExpressionPropName(name: string): boolean {
  return isCodePropName(name) && !/^use[A-Z]/.test(name);
}

/**
 * Choose the save route for SAVE_PROPERTY.
 *
 * BMP stores every expression slot as `CorpoExtendedExpression`. The binary
 * `IntegrationUpdateCommand` sends a plain String for them and BMP rejects it
 * ("argument type mismatch"); the EC route stores the text exactly. So every
 * expression slot is saved through EC.
 *
 * `valueKind` is the kind the object read reported (`parseFullObject`). When
 * the caller passes it, it decides; when it does not, the property name does.
 */
export function savesViaExtendedCode(property: string, valueKind?: ValueKind): boolean {
  if (EC_SAVE_PROPS.has(property)) return true;
  if (valueKind !== undefined && valueKind !== 'unknown') return valueKind === 'code';
  return isExpressionPropName(property);
}

const NUMBER_CLASSES = /^java\.(lang\.(Integer|Long|Short|Byte|Double|Float)|math\.(BigDecimal|BigInteger))$/;

/** Java collections and BMP's own sequence classes (SeqListImpl …). Not a
 *  bare "...List" suffix: ConditionGroupList is a structured value. */
function isCollectionClass(cls: string): boolean {
  const short = simpleClass(cls);
  return /^Seq\w*Impl$/.test(short) || (cls.startsWith('java.util.') && /(List|Set|Collection)/.test(short));
}

function simpleClass(cls: string): string {
  const i = cls.lastIndexOf('.');
  return i < 0 ? cls : cls.slice(i + 1);
}

function ridText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isSafeInteger(v) ? String(v) : null;
  if (typeof v === 'object') {
    const o = v as { identifier?: unknown; value?: unknown; rid?: unknown };
    if (o.identifier != null) return ridText(o.identifier);
    if (o.rid != null) return ridText(o.rid);
    if (o.value != null) return ridText(o.value);
  }
  return null;
}

function listItems(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v instanceof Set) return [...v];
  if (v && typeof v === 'object') {
    const o = v as { $elements?: unknown; delegate?: unknown };
    if (Array.isArray(o.$elements)) return o.$elements;
    if (o.delegate != null) return listItems(o.delegate);
  }
  return null;
}

function scalarText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof JavaEnum) return v.name;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const key of ['formattedValue', 'value', 'text', 'name', 'identifier', 'typeId']) {
      if (o[key] != null && typeof o[key] !== 'object') return String(o[key]);
    }
  }
  return '';
}

function numberValue(raw: unknown): PropValue {
  if (typeof raw === 'bigint') {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? { kind: 'number', text: raw.toString(), num: n } : { kind: 'number', text: raw.toString() };
  }
  if (typeof raw === 'number') return { kind: 'number', text: String(raw), num: raw };
  const text = scalarText(raw);
  const n = Number(text);
  return text !== '' && Number.isFinite(n) ? { kind: 'number', text, num: n } : { kind: 'number', text };
}

function timeText(o: Record<string, unknown>): string {
  if (typeof o.formattedValue === 'string' && o.formattedValue) return o.formattedValue;
  const ms = o.ms;
  if (typeof ms === 'bigint' || typeof ms === 'number') {
    const n = Number(ms);
    if (Number.isFinite(n)) {
      const d = new Date(n);
      if (!Number.isNaN(d.getTime())) return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
    }
  }
  return '';
}

/** Classify one raw property value. `name` refines plain strings that are
 *  known to carry code. */
export function toPropValue(name: string, raw: unknown): PropValue {
  if (raw == null) return { kind: isCodePropName(name) ? 'code' : 'unknown', text: '' };
  if (typeof raw === 'string') return { kind: isCodePropName(name) ? 'code' : 'text', text: raw };
  if (typeof raw === 'boolean') return { kind: 'boolean', text: String(raw), bool: raw };
  if (typeof raw === 'number' || typeof raw === 'bigint') return numberValue(raw);
  if (raw instanceof JavaEnum) {
    return { kind: 'enum', text: raw.name, enumClass: simpleClass(raw.desc?.name ?? '') || undefined };
  }
  if (typeof raw !== 'object') return { kind: 'unknown', text: String(raw) };

  const o = raw as Record<string, unknown>;
  const cls = typeof o.$class === 'string' ? o.$class : typeof o.$type === 'string' ? o.$type : '';
  if (cls === 'java.lang.Boolean') {
    const b = o.value === true || o.value === 'true';
    return { kind: 'boolean', text: String(b), bool: b };
  }
  if (NUMBER_CLASSES.test(cls)) return numberValue(o.value);
  if (cls === 'java.lang.String') return toPropValue(name, typeof o.value === 'string' ? o.value : '');
  // The class is kept: code search tells Extended Code (CorpoExtendedExpression)
  // from time expressions, which are classified here too.
  if (cls.includes('Expression')) return { kind: 'code', text: scalarText(o.value ?? o.expression ?? ''), cls: simpleClass(cls) };
  if (cls.includes('HtmlText')) return { kind: 'html', text: scalarText(o) };
  if (cls.includes('CorpoTime') || cls.startsWith('java.time.')) return { kind: 'time', text: timeText(o) || scalarText(o) };
  const items = listItems(raw);
  if (items) {
    const texts = items.map(item => (item instanceof JavaEnum ? item.name : ridText(item) ?? scalarText(item))).filter(t => t !== '');
    return { kind: 'list', text: texts.length ? texts.join(', ') : '', items: texts };
  }
  // A collection with no element array of its own (an empty SeqListImpl has
  // no delegate, Collections$EmptyList no elements) is an empty list, never
  // its class name.
  if (isCollectionClass(cls)) return { kind: 'list', text: '', items: [] };
  if (cls.endsWith('.Rid')) return { kind: 'text', text: ridText(o) ?? '' };
  // EditField.propertyMapping: `propertyName` holds either the numeric rid of
  // a property definition or the accessor name of a built-in property.
  if (simpleClass(cls) === 'PropertyMapping') {
    const pn = o.propertyName;
    const text = pn == null ? '' : typeof pn === 'object' ? ridText(pn) ?? scalarText(pn) : String(pn).trim();
    return { kind: 'text', text, cls: 'PropertyMapping' };
  }
  const short = simpleClass(cls);
  return { kind: 'unknown', text: scalarText(o), ...(short ? { cls: short } : {}) };
}

/** Read the `references` HashMap (or a plain object) into role → rid strings. */
export function parseReferences(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as { $map?: unknown; $entries?: unknown };
  let entries: Array<[unknown, unknown]>;
  if (Array.isArray(o.$entries)) entries = o.$entries as Array<[unknown, unknown]>;
  else if (o.$map && typeof o.$map === 'object') entries = Object.entries(o.$map as Record<string, unknown>);
  else entries = Object.entries(raw as Record<string, unknown>).filter(([k]) => !k.startsWith('$'));
  for (const [key, value] of entries) {
    const role = key instanceof JavaEnum ? key.name : ridText(key) ?? String(key ?? '');
    if (!role) continue;
    const items = listItems(value) ?? (value == null ? [] : [value]);
    out[role] = items.map(ridText).filter((r): r is string => !!r);
  }
  return out;
}

function parseStringSet(raw: unknown): string[] {
  const items = listItems(raw);
  return items ? items.map(i => (i instanceof JavaEnum ? i.name : String(i))) : [];
}

/** Parse a deserialized ObjectData (or an IntegrationObjectResponse wrapping
 *  one) into a FullObject. Returns null when the payload is not an object read. */
export function parseFullObject(input: unknown): FullObject | null {
  if (!input || typeof input !== 'object') return null;
  let raw = input as Record<string, unknown>;
  if (raw.response && typeof raw.response === 'object' && !('props' in raw)) raw = raw.response as Record<string, unknown>;
  const rawProps = raw.props;
  if (!rawProps || typeof rawProps !== 'object') return null;

  let rid = '';
  let type = '';
  const props: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(rawProps as Record<string, unknown>)) {
    if (key === '_rid') { rid = ridText(value) ?? ''; continue; }
    if (key === '_type') { type = scalarText(value); continue; }
    if (key.startsWith('$')) continue;
    props[key] = toPropValue(key, value);
  }
  if (!type && props.typeKey) type = props.typeKey.text;
  const references = parseReferences(raw.references);
  noteFileLinks(type, props, references);
  return {
    rid,
    type,
    name: props.name?.text ?? '',
    businessId: props.id?.text ?? '',
    props,
    references,
    overridden: parseStringSet(raw.overridden),
  };
}

/** A property that links to a file (the image of a button) is held in `props`
 *  as the RID of the file, '' when there is none, so the window edits it like
 *  any other property. The link itself is in `references`. */
export function noteFileLinks(type: string, props: Record<string, PropValue>, references: Record<string, string[]>): void {
  for (const prop of fileLinkPropsOf(type)) {
    const own = props[prop]?.text ?? '';
    const rid = references[prop]?.[0] ?? (/^-?\d+$/.test(own) ? own : '');
    props[prop] = { kind: 'text', text: rid };
  }
}

/** Build a FullObject from the Extended Code object-pane read. Used when the
 *  binary object read fails on the server (some objects on older servers):
 *  the window then shows identity and the known pane properties only.
 *  `overridden` stays empty: the pane read cannot tell an explicit override. */
export function fullObjectFromPane(pane: import('./types').ObjectPanePayload): FullObject {
  const props: Record<string, PropValue> = {};
  const put = (name: string, raw: string, kind: ValueKind = 'text') => {
    if (!raw || props[name]) return;
    if (kind === 'text' && (raw === 'true' || raw === 'false')) {
      props[name] = { kind: 'boolean', text: raw, bool: raw === 'true' };
      return;
    }
    props[name] = { kind, text: raw };
  };
  for (const [name, value] of Object.entries(pane.codeFields)) put(name, value, 'code');
  for (const [name, value] of Object.entries(pane.instanceProps)) put(name, value);
  for (const [name, value] of Object.entries(pane.contextValues)) put(name, value);
  for (const [name, value] of Object.entries(pane.gateValues)) put(name, value);
  const references: Record<string, string[]> = {};
  if (pane.parent?.rid) references.parent = [pane.parent.rid];
  if (pane.template?.rid) references.template = [pane.template.rid];
  for (const [role, target] of Object.entries(pane.references)) {
    if (target?.rid) references[role] = [target.rid];
  }
  for (const [role, items] of Object.entries(pane.lists)) {
    const rids = items.map(item => item.rid).filter(Boolean);
    if (rids.length) references[role] = rids;
  }
  noteFileLinks(pane.instance.type, props, references);
  return {
    rid: pane.instance.rid,
    type: pane.instance.type,
    name: pane.instance.name,
    businessId: pane.instance.businessId,
    props,
    references,
    overridden: [],
  };
}
