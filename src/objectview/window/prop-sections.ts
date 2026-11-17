/**
 * Object window — the property sections of a data object (CeProcedure …).
 *
 * Order:
 *  1. the type's curated groups without Audit ("General": description …);
 *  2. one section per custom category, in `sortIndex` order of its first
 *     property ("Other" for no category or `#L#defaultTypes.misc`). Custom
 *     properties that the object does not hold are listed from the schema
 *     as "Not set";
 *  3. Advanced: every other built-in property that holds a value;
 *  4. Audit: created / modified, read-only as a whole.
 * Relations are drawn by the view (object chips) between 3 and 4.
 *
 * Advanced, Relations and Audit start collapsed. Until the schema arrives,
 * custom properties from the read sit in one "Custom" section, read-only.
 *
 * Pure: no DOM, no chrome.*.
 */

import type { FullObject, ObjectSummary, PropValue } from '../../lib/object-read';
import { isCustomKey, isEmptyValue, splitWords, tableLabel, typeInfo } from '../../lib/object-window-table';
import {
  ABSENT, customModels, customSections, REASON_TEXT, storedValue,
  type PropertyKind, type PropertyModel, type TypePropertySchema,
} from '../../lib/property-schema';

function usableLabel(label: string | undefined): string | undefined {
  const l = label?.trim();
  return l && !l.startsWith('#L#') ? l : undefined;
}

/** Built-in label: table, then the cached field list, then the accessor. */
export function builtinLabel(prop: string, labels?: Readonly<Record<string, string>>): string {
  if (prop === 'id') return 'ID';
  if (prop === 'name') return 'Name';
  return tableLabel(prop) ?? usableLabel(labels?.[prop]) ?? splitWords(prop);
}

export interface SectionRow {
  /** Key in the read: definition RID (custom) or accessor / role. */
  key: string;
  label: string;
  /** Accessor (built-in) or business ID (custom); '' when unknown. */
  ident: string;
  custom: boolean;
  /** Kind of the value (property-schema kinds; built-ins by their read kind). */
  kind: PropertyKind;
  /** Custom: the schema model (editability, options). */
  model?: PropertyModel;
  /** Stored value in property-schema's canonical form (ABSENT when not set). */
  stored: string;
  /** Holds a value (a stored false counts). */
  has: boolean;
  /** Reference targets (reference kinds and audit users). */
  rids?: string[];
  /** One-line reason the row cannot be edited (none for editable rows and
   *  for rows of a section that says it once). */
  reason?: string;
  /** Raw read value (built-ins). */
  value?: PropValue;
}

export interface PropSection {
  key: string;
  title: string;
  rows: SectionRow[];
  /** Starts collapsed (Advanced, Relations, Audit). */
  collapsed?: boolean;
  /** Said once in the header of a section that is read-only as a whole. */
  note?: string;
  /** A custom category (the header says so). */
  category?: boolean;
}

export interface SectionInput {
  summaries: Readonly<Record<string, ObjectSummary>>;
  labels?: Readonly<Record<string, string>>;
  schema?: TypePropertySchema;
  /** Why the schema is missing (error), or undefined while loading. */
  schemaError?: string;
}

const AUDIT_PROPS = ['createdTime', 'lastModifiedDate'];
const AUDIT_ROLES = ['createdBy', 'lastModifiedBy'];
const AUDIT_LABEL: Record<string, string> = {
  createdTime: 'Created', createdBy: 'Created by', lastModifiedDate: 'Last modified', lastModifiedBy: 'Last modified by',
};
/** Built-ins that are read plumbing, not properties a configurator sets. */
const PLUMBING = new Set(['fullPath', 'uuid', 'typeKey', 'simpleName', 'model', 'id', 'name']);

export const ADVANCED_NOTE = 'Built-in values are not edited here';
export const AUDIT_NOTE = 'Set by the system';
export const RELATIONS_NOTE = 'Structure changes are made in the tree or in Blueprint';
export const NO_SCHEMA = 'The property schema could not be read';
export const SCHEMA_LOADING = 'Loading the property schema…';

function readKind(v: PropValue | undefined): PropertyKind {
  switch (v?.kind) {
    case 'boolean': return 'boolean';
    case 'number': return 'number';
    case 'time': return 'date';
    case 'html': return 'rich';
    case 'code': return 'code';
    case 'text': return v.text.includes('\n') ? 'multiline' : 'text';
    default: return 'other';
  }
}

/** The custom rows of the schema, plus custom values the read holds that
 *  the schema does not list. */
function customRows(obj: FullObject, input: SectionInput): Array<{ title: string; rows: SectionRow[] }> {
  const { schema } = input;
  if (!schema) {
    // Before the schema: what the read holds, read-only.
    const keys = [...new Set([...Object.keys(obj.props), ...Object.keys(obj.references)].filter(isCustomKey))];
    if (!keys.length) return [];
    const reason = input.schemaError ? NO_SCHEMA : SCHEMA_LOADING;
    const rows = keys.map(key => {
      const s = input.summaries[key];
      const rids = obj.references[key];
      const v = obj.props[key];
      const kind: PropertyKind = rids ? (rids.length > 1 ? 'referenceList' : 'reference') : readKind(v);
      const stored = storedValue(obj, key, kind);
      return {
        key, label: s?.name || s?.businessId || key, ident: s?.businessId ?? '', custom: true, kind, stored,
        has: stored !== ABSENT && (!!rids?.length || !isEmptyValue(v)), ...(rids ? { rids } : {}), ...(v ? { value: v } : {}), reason,
      } satisfies SectionRow;
    });
    return [{ title: 'Custom', rows }];
  }
  const models = customModels(schema);
  const known = new Set(models.map(m => m.key));
  const sections: Array<{ title: string; rows: SectionRow[] }> = customSections(models).map(sec => ({
    title: sec.title,
    rows: sec.rows.map(m => {
      const stored = storedValue(obj, m.key, m.kind);
      const rids = obj.references[m.key];
      return {
        key: m.key, label: m.label, ident: m.accessor, custom: true, kind: m.kind, model: m, stored,
        has: stored !== ABSENT && stored !== '',
        ...(rids ? { rids } : {}), ...(obj.props[m.key] ? { value: obj.props[m.key] } : {}),
        ...(m.editability.ok ? {} : { reason: m.editability.text }),
      } satisfies SectionRow;
    }),
  }));
  // Values of definitions this type's schema does not list (removed from the class).
  const stray = [...new Set([...Object.keys(obj.props), ...Object.keys(obj.references)])].filter(k => isCustomKey(k) && !known.has(k));
  if (stray.length) {
    const rows: SectionRow[] = stray.map(key => {
      const s = input.summaries[key];
      const rids = obj.references[key];
      const kind: PropertyKind = rids ? 'reference' : readKind(obj.props[key]);
      const stored = storedValue(obj, key, kind);
      return {
        key, label: s?.name || key, ident: s?.businessId ?? '', custom: true, kind, stored, has: stored !== ABSENT,
        ...(rids ? { rids } : {}), ...(obj.props[key] ? { value: obj.props[key] } : {}), reason: 'Not in this type’s property schema',
      };
    });
    const other = sections.find(s => s.title === 'Other');
    if (other) other.rows.push(...rows); else sections.push({ title: 'Other', rows });
  }
  return sections;
}

function builtinRow(obj: FullObject, key: string, input: SectionInput, label?: string): SectionRow {
  const v = obj.props[key];
  const kind = readKind(v);
  return {
    key, label: label ?? builtinLabel(key, input.labels), ident: key, custom: false, kind,
    stored: v ? (v.kind === 'boolean' ? String(v.bool ?? v.text === 'true') : v.text) : ABSENT,
    has: !!v && !isEmptyValue(v), ...(v ? { value: v } : {}),
  };
}

/** The sections of a data object, in order, without Relations. */
export function buildSections(obj: FullObject, input: SectionInput): { before: PropSection[]; after: PropSection[] } {
  const info = typeInfo(obj.type);
  const used = new Set<string>([...AUDIT_PROPS, ...PLUMBING]);
  const before: PropSection[] = [];
  for (const g of info.groups) {
    if (g.title === 'Audit') continue;
    const rows = g.fields.filter(f => f.prop && f.prop !== 'name' && Object.hasOwn(obj.props, f.prop))
      .map(f => ({ ...builtinRow(obj, f.prop!, input, f.label), reason: REASON_TEXT['built-in'] }));
    for (const r of rows) used.add(r.key);
    if (rows.length) before.push({ key: `g:${g.title}`, title: g.title, rows });
  }
  for (const sec of customRows(obj, input)) {
    before.push({ key: `c:${sec.title}`, title: sec.title, rows: sec.rows, category: true });
  }
  const advanced = Object.keys(obj.props)
    .filter(k => !isCustomKey(k) && !used.has(k) && !isEmptyValue(obj.props[k]))
    .map(k => builtinRow(obj, k, input))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (advanced.length) before.push({ key: 'advanced', title: 'Advanced', rows: advanced, collapsed: true, note: ADVANCED_NOTE });

  const audit: SectionRow[] = [];
  for (const k of ['createdTime', 'createdBy', 'lastModifiedDate', 'lastModifiedBy']) {
    if (AUDIT_ROLES.includes(k)) {
      const rids = obj.references[k];
      if (rids?.length) audit.push({ key: k, label: AUDIT_LABEL[k], ident: k, custom: false, kind: 'principal', stored: rids.join(','), has: true, rids });
    } else if (Object.hasOwn(obj.props, k)) {
      audit.push(builtinRow(obj, k, input, AUDIT_LABEL[k]));
    }
  }
  const after: PropSection[] = audit.length ? [{ key: 'audit', title: 'Audit', rows: audit, collapsed: true, note: AUDIT_NOTE }] : [];
  return { before, after };
}

/** Text a filter matches: label, ID, value. */
export function sectionRowHay(r: SectionRow, valueText: string): string {
  return `${r.label} ${r.ident} ${r.custom ? '' : r.key} ${valueText}`.toLowerCase();
}

/** A section is open when it holds an unsaved edit, else by the user's own
 *  choice, else by its default. */
export function sectionOpen(sec: Pick<PropSection, 'key' | 'collapsed'>, folds: ReadonlyMap<string, boolean>, dirty: number): boolean {
  if (dirty > 0) return true;
  return folds.get(sec.key) ?? !sec.collapsed;
}

/** The word for a custom property without a value. The object read gives an
 *  unset text property as an empty text (measured: never set and set to ""
 *  read the same), so an empty text is "Not set" as well. */
export const NOT_SET = 'Not set';

/** A text that begins or ends with white space, in quotes (`" QA"`): the
 *  review and the conflict dialog show it apart from the same text without
 *  it. Other texts unchanged. */
export function quoteEdges(text: string): string {
  return /^\s|\s$/.test(text) ? `"${text}"` : text;
}

/** A custom value in words: item names, On/Off, "Not set" (also for an empty
 *  text), the text. `quoteEdges`: quote a text with white space at either
 *  end. */
export function customValueText(
  stored: string,
  kind: PropertyKind,
  ctx: { items?: ReadonlyArray<{ rid: string; name: string }>; summaries?: Readonly<Record<string, ObjectSummary>>; quoteEdges?: boolean } = {},
): string {
  if (stored === ABSENT) return NOT_SET;
  switch (kind) {
    case 'boolean': return stored === 'true' ? 'On' : 'Off';
    case 'listItem':
    case 'reference':
    case 'principal':
    case 'referenceList':
      return stored.split(',').filter(Boolean).map(r => ctx.items?.find(i => i.rid === r)?.name || ctx.summaries?.[r]?.name || r).join(', ') || NOT_SET;
    default: return stored === '' ? NOT_SET : ctx.quoteEdges ? quoteEdges(stored) : stored;
  }
}

