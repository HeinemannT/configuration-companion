/**
 * Property schema: what kind each property of a type is, and whether the
 * object window may edit it.
 *
 * The source is BMP's own field description (`GetTypeFieldsCommand`, one
 * `FieldDto` per field), kept whole (`FieldDescription`), plus two facts the
 * description does not carry and that only the property definition object
 * has: its class (`HistoricalBooleanMethodConfig` …) and, for a list
 * property, the list set whose children are the allowed items.
 *
 * Facts measured on a live server that shape this module:
 *  - built-in fields have unresolvable `#L#…` categories and labels, one
 *    category per field: useless for grouping;
 *  - a custom field has a readable `displayName` and a category that is a
 *    free string or `#L#defaultTypes.misc`;
 *  - `historical` is always false for custom fields, also when the
 *    definition is a `Historical…MethodConfig` (the server computes it from
 *    an annotation custom properties never have): the class decides;
 *  - a list-item property stores a reference to an item of its list set;
 *    `options` are item names only, so items are chosen by RID. The only
 *    `choice: true` field measured is of this kind (`ListMethodConfig`,
 *    type `ListPropertySetItem`, the read holding the item RID under
 *    `references`). A `String` choice (kind `choice`) was never seen: its
 *    definition class and stored form are unknown, so it stays read-only
 *    (not on STORED_CLASSES).
 *  - a reference property (`ReferenceMethodConfig`,
 *    `HistoricalReferenceMethodConfig`) is described as `reference: true`,
 *    type `List` with `multiselect: true` for a list, else
 *    `BusinessTreeObject`; `referenceConstraints.sourceExpression` is the
 *    definition's `expression`. A definition without an expression ("by
 *    type") names its types only in `referenceConstraints.allowedTypes`
 *    (with `allowOnlyExactClass`). The read holds the value under
 *    `references[<definition>]`: the RIDs of a list (`[]` when empty), one
 *    RID for a single reference (absent or null when not set). The server
 *    does not check that a written object is one the property allows: the
 *    gate does (`AllowedObjects`).
 *
 * One model (`classifyField`) answers "what kind is this property and may it
 * be edited" for the window (which control to draw) and for the service
 * worker (the gate before a write). Pure: no DOM, no chrome.*.
 */

import { ecString, formatEcLiteral, validateEcIdentifier } from './ec-guards';
import { resolveNamespace } from './namespace';

// ── the description as BMP sends it ─────────────────────────────────

export interface ReferenceConstraints {
  allowedTypes: string[];
  allowBlank?: boolean;
  allowOnlyExactClass?: boolean;
  advanced?: boolean;
  filter?: string;
  selectionRoots?: string;
  sourceExpression?: string;
}

/** One field of a type, every attribute of BMP's FieldDto that the window
 *  or the gate can use. Absent booleans are false. */
export interface FieldDescription {
  /** `name`: the accessor of a built-in field, the definition RID of a custom one. */
  name: string;
  id: string;
  /** The accessor used in Extended Code (`_o.<businessId>`). */
  businessId: string;
  displayName: string;
  category: string;
  description?: string;
  sortIndex: number;
  /** Value class (`String`, `boolean`, `ListPropertySetItem`, `List` …). */
  type: string;
  collectionType?: string;
  editable?: boolean;
  readOnly?: boolean;
  calculated?: boolean;
  historical?: boolean;
  customField?: boolean;
  rich?: boolean;
  multilineStyle?: string;
  choice?: boolean;
  multiselect?: boolean;
  reference?: boolean;
  hidden?: boolean;
  unique?: boolean;
  options?: string[];
  enumConstants?: string[];
  referenceConstraints?: ReferenceConstraints;
  methodVisibility?: string;
  expert?: { cs?: boolean; web?: boolean };
  locationsWhereVisible?: string[];
}

/** Facts of a custom property's definition object. */
export interface DefinitionFacts {
  /** Definition class, e.g. `ListMethodConfig`, `HistoricalBooleanMethodConfig`. */
  configClass: string;
  /** The list set of a list property (`listPropertySet` reference). */
  listSetRid?: string;
  /** The definition's own `allowBlank`. The field description of a custom
   *  list property carries no reference constraints, so this is the source.
   *  True when the definition says true, false when it says false, absent
   *  when it says nothing (a list item treats absent as false). */
  allowBlank?: boolean;
  /** Reference definitions: `required` is true. */
  required?: boolean;
  /** Reference definitions: the definition's `multiselect`, when it says. */
  multiselect?: boolean;
  /** Reference definitions: the definition has a non-empty `expression`
   *  (the Extended Code that yields the allowed objects: AllowedSource
   *  `advanced`); without it the allowed objects are by type. The
   *  expression text itself is never kept or sent (the allowed-objects
   *  read names the definition). */
  hasExpression?: boolean;
  /** Reference definitions: the definition's `selectionRoots` is set. The
   *  read gives a display text of the root names (`"[Enterprise procedure]"`
   *  measured), not objects, so the roots cannot be applied here. */
  hasSelectionRoots?: boolean;
  /** Reference definitions: the definition's `filtered` is true. Its
   *  `filter` itself is opaque in the read (`""` measured also after a filter
   *  was written), so this flag is the only sign of a filter. */
  filtered?: boolean;
}

/** A valid type name, as Extended Code takes it literally (`SELECT <type>`). */
export const VALID_TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * Where the allowed objects of an editable reference property come from:
 * `advanced`, the definition's expression calculated on the object
 * (buildAllowedObjectsEc); `by-type`, every object of the named types
 * (buildAllowedByTypeEc), of exactly those classes when `exactClass`, else
 * with their subclasses. Derived from the schema by the worker
 * (`allowedSourceOf`); the window never sends it.
 */
export type AllowedSource =
  | { mode: 'advanced' }
  | { mode: 'by-type'; types: readonly string[]; exactClass: boolean };

export interface ListItem {
  rid: string;
  id: string;
  name: string;
}

/** The objects a reference property allows for one object (the definition's
 *  expression calculated on that object, or every object of its allowed
 *  types: AllowedSource): RID, ID, name, at most LIST_ITEMS_MAX. `tooMany`:
 *  there are more; `items` is cut and the row is read-only ("The list is
 *  too long to choose from here"). */
export interface AllowedObjects {
  items: ListItem[];
  tooMany?: boolean;
}

/** Everything the window needs to draw and edit a type's properties. */
export interface TypePropertySchema {
  type: string;
  fields: FieldDescription[];
  /** Definition RID → facts (custom fields only). */
  definitions: Record<string, DefinitionFacts>;
  /** Definition RID → the items of its list set (list properties only). */
  listItems: Record<string, ListItem[]>;
  /** Definitions whose facts or items could not be read: their rows are read-only. */
  unreadDefinitions?: Record<string, string>;
  /** Definition RID → item count of a list set longer than LIST_ITEMS_MAX
   *  (its items are cut; the row is read-only and says why). */
  listTooLong?: Record<string, number>;
}

/** `rec[key]` only when `key` is a string and an OWN key of `rec`: a
 *  definition, accessor or RID such as `constructor` or `__proto__` never
 *  reaches Object.prototype. */
export function ownValue<T>(rec: Readonly<Record<string, T>> | undefined, key: unknown): T | undefined {
  return rec && typeof key === 'string' && Object.hasOwn(rec, key) ? rec[key] : undefined;
}

// ── parsing the deserialised FieldDto ─────────────────────────────────

const str = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v && typeof v === 'object') {
    const o = v as { typeId?: unknown; name?: unknown; value?: unknown };
    if (typeof o.typeId === 'string') return o.typeId;
    if (typeof o.name === 'string') return o.name;
    if (typeof o.value === 'string') return o.value;
  }
  return '';
};

function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const o = v as { $elements?: unknown; a?: unknown };
    if (Array.isArray(o.$elements)) return o.$elements;
    if (Array.isArray(o.a)) return o.a;
  }
  return [];
}

const strings = (v: unknown): string[] => list(v).map(str).filter(Boolean);
const flag = (v: unknown): boolean | undefined => (v === true ? true : undefined);

/** One deserialised FieldDto (or an already plain object) → FieldDescription. */
export function parseFieldDescription(raw: unknown): FieldDescription | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const id = str(v.id);
  const name = str(v.name) || id;
  if (!name) return null;
  const rc = v.referenceConstraints as Record<string, unknown> | null | undefined;
  const expert = v.expert as { cs?: unknown; web?: unknown } | null | undefined;
  const out: FieldDescription = {
    name, id: id || name,
    businessId: str(v.businessId),
    displayName: str(v.displayName),
    category: str(v.category),
    sortIndex: typeof v.sortIndex === 'number' ? v.sortIndex : Number(v.sortIndex) || 0,
    type: str(v.type),
  };
  const set = <K extends keyof FieldDescription>(k: K, value: FieldDescription[K] | undefined) => {
    if (value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)) out[k] = value;
  };
  set('description', str(v.description) || undefined);
  set('collectionType', str(v.collectionType) || undefined);
  for (const k of ['editable', 'readOnly', 'calculated', 'historical', 'customField', 'rich', 'choice', 'multiselect', 'reference', 'hidden', 'unique'] as const) {
    set(k, flag(v[k]));
  }
  set('multilineStyle', str(v.multilineStyle) || undefined);
  set('options', strings(v.options));
  set('enumConstants', strings(v.enumConstants));
  set('methodVisibility', str(v.methodVisibility) || undefined);
  set('locationsWhereVisible', strings(v.locationsWhereVisible));
  if (expert && typeof expert === 'object' && (expert.cs === true || expert.web === true)) {
    out.expert = { ...(expert.cs === true ? { cs: true } : {}), ...(expert.web === true ? { web: true } : {}) };
  }
  if (rc && typeof rc === 'object') {
    out.referenceConstraints = {
      allowedTypes: strings(rc.allowedTypes),
      ...(typeof rc.allowBlank === 'boolean' ? { allowBlank: rc.allowBlank } : {}),
      ...(typeof rc.allowOnlyExactClass === 'boolean' ? { allowOnlyExactClass: rc.allowOnlyExactClass } : {}),
      ...(typeof rc.advanced === 'boolean' ? { advanced: rc.advanced } : {}),
      ...(str(rc.filter) ? { filter: str(rc.filter) } : {}),
      ...(str(rc.selectionRoots) ? { selectionRoots: str(rc.selectionRoots) } : {}),
      ...(str(rc.sourceExpression) ? { sourceExpression: str(rc.sourceExpression) } : {}),
    };
  }
  return out;
}

// ── kinds and editability ─────────────────────────────────────────────

export type PropertyKind =
  | 'text' | 'multiline' | 'rich' | 'number' | 'boolean' | 'choice' | 'listItem'
  | 'date' | 'reference' | 'principal' | 'referenceList' | 'code' | 'file' | 'other';

/** Reference kinds: one object, one user or group (treated exactly like a
 *  reference), a list of objects. Values are object RIDs; the allowed ones
 *  come from the definition's expression, per object (AllowedObjects). */
export type ReferenceKind = 'reference' | 'principal' | 'referenceList';
export const REFERENCE_KINDS: ReadonlySet<PropertyKind> = new Set<ReferenceKind>(['reference', 'principal', 'referenceList']);
export function isReferenceKind(k: string): k is ReferenceKind {
  return REFERENCE_KINDS.has(k as PropertyKind);
}

/** Kinds this package can write. */
export type EditKind = 'text' | 'multiline' | 'number' | 'boolean' | 'choice' | 'listItem' | ReferenceKind;
export const EDIT_KINDS: ReadonlySet<PropertyKind> = new Set<EditKind>(['text', 'multiline', 'number', 'boolean', 'choice', 'listItem', 'reference', 'principal', 'referenceList']);
export function isEditKind(k: string): k is EditKind {
  return EDIT_KINDS.has(k as PropertyKind);
}

export type ReadOnlyReason =
  | 'built-in' | 'hidden' | 'calculated' | 'read-only' | 'historical' | 'unread-definition' | 'later'
  | 'not-stored' | 'no-options' | 'accessor-collision' | 'list-too-long' | 'by-type' | 'selection-roots' | 'filtered' | 'kind-mismatch';

/**
 * The definition classes whose values are stored plainly on the object and
 * that this package writes, with the kinds each may have. Allow-list: any
 * other class (Extended/calculated, reverse reference, function, token,
 * tag, URL, file, date, rich text, status, progress, a class not seen yet)
 * is read-only, whatever the field description says. The class list is
 * from the server model (`model/config/*MethodConfig`); the four plain ones
 * keep their value as a single stored value, the `Historical…` ones as dated
 * entries (written only while HISTORICAL_CUSTOM_WRITES is on).
 */
export const STORED_CLASSES: Readonly<Record<string, readonly PropertyKind[]>> = {
  TextMethodConfig: ['text', 'multiline'],
  NumberMethodConfig: ['number'],
  BooleanMethodConfig: ['boolean'],
  ListMethodConfig: ['listItem'],
};
const HISTORICAL_STORED: Readonly<Record<string, readonly PropertyKind[]>> = {
  HistoricalTextMethodConfig: ['text', 'multiline'],
  HistoricalNumberMethodConfig: ['number'],
  HistoricalBooleanMethodConfig: ['boolean'],
  HistoricalListMethodConfig: ['listItem'],
};

/**
 * Reference definitions, with the kinds each may have. Written with a plain
 * `_o.change(<accessor> := …)` also when the class is the Historical one,
 * whatever HISTORICAL_CUSTOM_WRITES says. Measured on BMP 5.6.17: a plain
 * change of a Historical reference takes effect from the moment of the
 * write; earlier dates keep the old value (the model's `dated`).
 */
export const REFERENCE_CLASSES: Readonly<Record<string, readonly PropertyKind[]>> = {
  ReferenceMethodConfig: ['reference', 'principal', 'referenceList'],
  HistoricalReferenceMethodConfig: ['reference', 'principal', 'referenceList'],
};

/** Simple class name (`…config.TextMethodConfig` → `TextMethodConfig`). */
const simpleClass = (c: string | undefined): string => (c ?? '').split('.').pop() ?? '';

/** Whether values of `configClass` are stored plainly and may hold `kind`. */
export function storedClassAllows(configClass: string | undefined, kind: PropertyKind, historicalWrites = HISTORICAL_CUSTOM_WRITES): boolean {
  const c = simpleClass(configClass);
  const kinds = Object.hasOwn(STORED_CLASSES, c) ? STORED_CLASSES[c]
    : Object.hasOwn(REFERENCE_CLASSES, c) ? REFERENCE_CLASSES[c]
      : historicalWrites && Object.hasOwn(HISTORICAL_STORED, c) ? HISTORICAL_STORED[c] : undefined;
  return !!kinds?.includes(kind);
}

/** Items of one list set the editor offers at most; a longer list is read-only. */
export const LIST_ITEMS_MAX = 2000;
/** Custom changes per write post at most (the worker refuses more). */
export const MAX_CUSTOM_CHANGES = 100;

/**
 * Switch for writing historical (`Historical…MethodConfig`) custom values.
 * ON: they are written with a plain `_o.change(<accessor> := <value>)`.
 * Measured on BMP 5.6.17 for text, boolean, list item and reference
 * definitions: the value takes effect from the moment of the write and
 * earlier dates keep the old one. A clear removes every dated value, so
 * "Not set" is never offered on a historical list item or single reference.
 * OFF: such rows (references excepted) are read-only.
 */
export const HISTORICAL_CUSTOM_WRITES = true;

/** The one line of reason per read-only state. Shared wording. */
export const REASON_TEXT: Readonly<Record<Exclude<ReadOnlyReason, 'later'>, string>> = {
  'built-in': 'Not editable here',
  hidden: 'Hidden for this type',
  calculated: 'Calculated by Extended Code',
  'read-only': 'Read-only for this type',
  historical: 'Historical value: editing comes next',
  'unread-definition': 'Its definition could not be read',
  'not-stored': 'Not a plainly stored value: edited in Configuration Studio',
  'no-options': 'No values to choose from are defined for it',
  'accessor-collision': 'Its ID is also the name of a built-in property',
  'list-too-long': 'The list is too long to choose from here',
  'by-type': 'Its allowed objects could not be determined',
  'selection-roots': 'Limited to selection roots: editing comes in a later version',
  filtered: 'Limited by a filter: editing comes in a later version',
  'kind-mismatch': 'Its definition does not match its field description',
};

/** A value outside the objects a reference property allows (the gate's and
 *  the window's words). */
export const NOT_ALLOWED_OBJECT = 'Not one of the objects this property allows';
/** "Not set" of a single reference whose definition is historical: a clear
 *  would remove every dated value. */
export const DATED_NO_CLEAR = 'A dated reference cannot be cleared here: clearing removes its history';
/** The note of a dated (Historical) reference row: a saved change takes
 *  effect from the moment of the write. For the row and the review. */
export const DATED_NOTE = 'Takes effect from today; earlier dates keep the old value';

const LATER: Readonly<Record<PropertyKind, string>> = {
  text: '', multiline: '', number: '', boolean: '', choice: '', listItem: '', reference: '', principal: '', referenceList: '',
  rich: 'rich text', date: 'dates', code: 'code properties', file: 'files', other: 'this kind of value',
};

/** "Editing <what> comes in a later version", the one wording for kinds
 *  that later packages make editable. */
export function laterText(kind: PropertyKind): string {
  return `Editing ${LATER[kind] || 'this kind of value'} comes in a later version`;
}

export type Editability = { ok: true } | { ok: false; reason: ReadOnlyReason; text: string };

export interface PropertyModel {
  /** Key in the object read: definition RID (custom) or accessor (built-in). */
  key: string;
  /** EC accessor (`businessId`). */
  accessor: string;
  label: string;
  custom: boolean;
  /** Section title of a custom property ("Other" for none / misc). */
  category: string;
  order: number;
  kind: PropertyKind;
  /** Number kinds: integer types refuse a decimal point. */
  integer?: boolean;
  historical: boolean;
  /** Choice: allowed strings. List item: see `TypePropertySchema.listItems`. */
  options?: string[];
  /** "Not set" may be chosen. List item: its definition allows a blank
   *  value (`allowBlank` of the ListMethodConfig); written as a clear.
   *  Single reference: the definition allows a blank value, is not required
   *  and is not historical (a clear would remove its history); written as a
   *  clear. List of references: the definition does not say `allowBlank`
   *  false nor `required` true; written as `LIST()`. */
  allowBlank?: boolean;
  /** Reference kinds of a Historical definition: a saved change takes effect
   *  from the moment of the write (DATED_NOTE), earlier dates keep the old
   *  value. Always with `historical: true`. */
  dated?: boolean;
  editability: Editability;
}

export const OTHER_CATEGORY = 'Other';

const INTEGER_TYPES = new Set(['int', 'Integer', 'long', 'Long', 'short', 'Short', 'byte', 'Byte', 'BigInteger']);
const DECIMAL_TYPES = new Set(['double', 'Double', 'float', 'Float', 'BigDecimal', 'Number', 'Decimal']);
const DATE_TYPES = new Set(['CorpoTime', 'Date', 'LocalDate', 'LocalDateTime', 'CorpoDate', 'Instant', 'ZonedDateTime']);
const PRINCIPAL_TYPES = new Set(['User', 'Group', 'UserGroup', 'Principal', 'Role']);
const CODE_TYPES = /Expression$/;
const FILE_TYPES = new Set(['FileContent', 'IconName', 'Image', 'SvgIcon', 'File']);
const RICH_TYPES = new Set(['HtmlText', 'RichText', 'Html']);

/** Category title of a custom property: its free string, else "Other". */
export function categoryTitle(raw: string | undefined): string {
  const c = (raw ?? '').trim();
  return !c || c.startsWith('#L#') ? OTHER_CATEGORY : c;
}

function isPrincipalRef(f: FieldDescription): boolean {
  if (PRINCIPAL_TYPES.has(f.type) || (f.collectionType && PRINCIPAL_TYPES.has(f.collectionType))) return true;
  if (f.referenceConstraints?.allowedTypes.some(t => PRINCIPAL_TYPES.has(t))) return true;
  const source = f.referenceConstraints?.sourceExpression ?? '';
  return /^\s*root\.(user|group)\b/.test(source) || /^\s*SELECT\s+(User|Group)\b/i.test(source);
}

export function kindOf(f: FieldDescription): { kind: PropertyKind; integer?: boolean } {
  // A single list item (stored as a reference to one item of the list set).
  // A multiselect list keeps its items in a form not measured yet: read-only.
  if (f.type === 'ListPropertySetItem' && !f.multiselect) return { kind: 'listItem' };
  if (f.multiselect || (f.reference && f.type === 'List')) return { kind: 'referenceList' };
  if (f.reference) return { kind: isPrincipalRef(f) ? 'principal' : 'reference' };
  if (f.type === 'boolean' || f.type === 'Boolean') return { kind: 'boolean' };
  if (INTEGER_TYPES.has(f.type)) return { kind: 'number', integer: true };
  if (DECIMAL_TYPES.has(f.type)) return { kind: 'number' };
  if (DATE_TYPES.has(f.type)) return { kind: 'date' };
  if (FILE_TYPES.has(f.type)) return { kind: 'file' };
  if (CODE_TYPES.test(f.type)) return { kind: 'code' };
  if (f.rich || RICH_TYPES.has(f.type)) return { kind: 'rich' };
  if (f.type === 'String' || f.type === 'string' || f.type === 'URI' || f.type === 'Url') {
    // A choice stays a choice; without options it is read-only, never free text.
    if (f.choice) return { kind: 'choice' };
    const ml = (f.multilineStyle ?? '').trim();
    return { kind: ml && ml.toUpperCase() !== 'NONE' && ml.toUpperCase() !== 'SINGLE' ? 'multiline' : 'text' };
  }
  return { kind: 'other' };
}

/** Whether a definition class is a historical (time-dependent) one. */
export function isHistoricalClass(configClass: string | undefined): boolean {
  return !!configClass && /^Historical/.test(configClass.split('.').pop() ?? '');
}

/** Whether a reference property may be emptied ("Not set"), by decision:
 *  a single reference only by a clear, never on a historical definition (a
 *  clear removes every dated value), only when the definition allows blank
 *  and is not required; a list (`LIST()`) unless the definition says
 *  `allowBlank` false or `required` true. `allowBlank` falls back to the
 *  field description's reference constraints when the definition is silent. */
export function referenceMayBeEmpty(kind: ReferenceKind, def: DefinitionFacts | undefined, f: FieldDescription, historical: boolean): boolean {
  const blank = def?.allowBlank ?? f.referenceConstraints?.allowBlank;
  if (def?.required === true) return false;
  if (kind === 'referenceList') return blank !== false;
  return !historical && blank === true;
}

/**
 * Why the allowed objects of a reference definition WITHOUT an expression
 * ("by type") cannot be listed here, or null when they can: selection roots
 * set (on the definition or in the field description), a filter (`filtered`
 * true), or no allowed types named / a name that is not a valid type name.
 * The allowed types are readable as names only in the field description
 * (`referenceConstraints.allowedTypes`); the definition read gives `types`
 * as `""` (measured on BMP 5.6.17).
 */
export function byTypeBlock(f: FieldDescription, def: DefinitionFacts): 'selection-roots' | 'filtered' | 'by-type' | null {
  if (def.hasSelectionRoots || (f.referenceConstraints?.selectionRoots ?? '').trim()) return 'selection-roots';
  if (def.filtered) return 'filtered';
  const types = f.referenceConstraints?.allowedTypes ?? [];
  if (!types.length || !types.every(t => VALID_TYPE_NAME.test(t))) return 'by-type';
  return null;
}

/** Where the allowed objects of reference definition `def` come from: its
 *  expression, or the field description's allowed types (each once, in
 *  order; exact class when `allowOnlyExactClass` is true). Undefined when
 *  neither applies (byTypeBlock). Editability is classifyField's question. */
export function allowedSourceOf(f: FieldDescription, def: DefinitionFacts | undefined): AllowedSource | undefined {
  if (!def) return undefined;
  if (def.hasExpression) return { mode: 'advanced' };
  if (byTypeBlock(f, def)) return undefined;
  return { mode: 'by-type', types: [...new Set(f.referenceConstraints!.allowedTypes)], exactClass: f.referenceConstraints?.allowOnlyExactClass === true };
}

/**
 * The model of one field: kind, section, order and whether the window may
 * edit it. Built-in fields are never editable through this route (they keep
 * their own routes); custom fields are editable only when the description
 * says editable, not read-only, not calculated, not hidden, the kind is one
 * this package writes, and the definition is not historical (unless the
 * historical switch is on). Reference kinds are editable also on a
 * Historical definition (plain change, `dated`), with an `expression` on
 * the definition (the allowed objects are calculated per object) or without
 * one when the allowed objects are every object of the named types
 * (byTypeBlock says when not).
 */
export function classifyField(
  f: FieldDescription,
  def: DefinitionFacts | undefined,
  opts: {
    historicalWrites?: boolean;
    unreadDefinition?: boolean;
    /** Names and IDs of the type's built-in fields (an accessor that equals
     *  one would write the built-in). */
    builtinNames?: ReadonlySet<string>;
    /** The list set (list item) or the allowed objects (reference kinds)
     *  hold more than the editor offers. */
    listTooLong?: boolean;
  } = {},
): PropertyModel {
  const custom = f.customField === true;
  const { kind, integer } = kindOf(f);
  const historical = f.historical === true || isHistoricalClass(def?.configClass);
  const historicalWrites = opts.historicalWrites ?? HISTORICAL_CUSTOM_WRITES;
  const ref = isReferenceKind(kind);
  const no = (reason: ReadOnlyReason, text?: string): Editability => ({ ok: false, reason, text: text ?? (reason === 'later' ? laterText(kind) : REASON_TEXT[reason]) });
  let editability: Editability;
  if (!custom) editability = no('built-in');
  else if (f.hidden) editability = no('hidden');
  else if (f.calculated) editability = no('calculated');
  else if (f.readOnly || f.editable !== true) editability = no('read-only');
  else if (kind === 'choice' && !f.options?.length) editability = no('no-options');
  else if (!EDIT_KINDS.has(kind)) editability = no('later');
  else if (opts.unreadDefinition || !def) editability = no('unread-definition');
  // References are written with a plain change also on a Historical class.
  else if (historical && !historicalWrites && !ref) editability = no('historical');
  // Allow-list: only plainly stored definition classes of the matching kind.
  else if (!storedClassAllows(def.configClass, kind, historicalWrites)) editability = no('not-stored');
  else if (opts.builtinNames?.has(f.businessId)) editability = no('accessor-collision');
  else if (kind === 'listItem' && !def.listSetRid) editability = no('unread-definition');
  else if (ref && def.multiselect !== undefined && def.multiselect !== (kind === 'referenceList')) editability = no('kind-mismatch');
  // Without an expression: by type, unless roots, a filter or unnamed types limit it.
  else if (ref && !def.hasExpression && byTypeBlock(f, def)) editability = no(byTypeBlock(f, def)!);
  else if ((kind === 'listItem' || ref) && opts.listTooLong) editability = no('list-too-long');
  else editability = { ok: true };
  const label = f.displayName && !f.displayName.startsWith('#L#') ? f.displayName : (f.businessId || f.name);
  return {
    key: custom ? f.id : f.name,
    accessor: f.businessId || f.name,
    label,
    custom,
    category: custom ? categoryTitle(f.category) : '',
    order: f.sortIndex,
    kind,
    ...(integer ? { integer: true } : {}),
    historical,
    ...(kind === 'choice' && f.options ? { options: [...f.options] } : {}),
    // A historical list item is never cleared (a clear removes its history).
    ...(kind === 'listItem' && def?.allowBlank === true && !historical ? { allowBlank: true } : {}),
    ...(ref && referenceMayBeEmpty(kind, def, f, historical) ? { allowBlank: true } : {}),
    ...(historical && editability.ok ? { dated: true } : {}),
    editability,
  };
}

/** Custom fields of a schema as models, in `sortIndex` order. */
export function customModels(schema: TypePropertySchema, opts: { historicalWrites?: boolean } = {}): PropertyModel[] {
  const builtinNames = builtinNamesOf(schema);
  return schema.fields
    .filter(f => f.customField === true && /^\d+$/.test(f.id))
    .map(f => classifyModel(schema, f, { ...opts, builtinNames }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** The names and IDs of a schema's built-in fields. */
export function builtinNamesOf(schema: TypePropertySchema): Set<string> {
  const out = new Set<string>();
  for (const f of schema.fields) if (!f.customField) { out.add(f.name); if (f.businessId) out.add(f.businessId); }
  return out;
}

/** classifyField with everything the schema knows about the field. */
export function classifyModel(schema: TypePropertySchema, f: FieldDescription, opts: { historicalWrites?: boolean; builtinNames?: ReadonlySet<string> } = {}): PropertyModel {
  return classifyField(f, ownValue(schema.definitions, f.id), {
    ...opts,
    builtinNames: opts.builtinNames ?? builtinNamesOf(schema),
    unreadDefinition: !!ownValue(schema.unreadDefinitions, f.id),
    listTooLong: !!ownValue(schema.listTooLong, f.id),
  });
}

/** Custom sections: one per category, ordered by the first property's
 *  `sortIndex`; rows inside in `sortIndex` order. */
export function customSections(models: readonly PropertyModel[]): Array<{ title: string; rows: PropertyModel[] }> {
  const by = new Map<string, PropertyModel[]>();
  for (const m of [...models].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))) {
    if (!m.custom) continue;
    const rows = by.get(m.category) ?? [];
    rows.push(m);
    by.set(m.category, rows);
  }
  return [...by].map(([title, rows]) => ({ title, rows }));
}

// ── stored values ─────────────────────────────────────────────────────

/** The text of "this custom property is not set" (absent from the read). */
export const ABSENT = '\u0000absent';

/** The object read's shape, as far as this module needs it. */
export interface ReadShape {
  props: Readonly<Record<string, { kind: string; text: string; bool?: boolean; num?: number }>>;
  references: Readonly<Record<string, readonly string[]>>;
}

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;

/** A decimal number as one canonical string: sign, digits without leading
 *  zeros, fraction without trailing zeros ("007.50" → "7.5", "-0" → "0").
 *  Never through a JS number, so an 18-digit integer keeps its last digit.
 *  Null when `s` is not a plain decimal. */
export function normalizeDecimal(s: string): string | null {
  const m = DECIMAL_TEXT.exec(s);
  if (!m) return null;
  const int = m[2].replace(/^0+(?=\d)/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const zero = int === '0' && !frac;
  return `${m[1] && !zero ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** A JS number as plain decimal text (no exponent, no grouping). */
function plainNumber(n: number): string {
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

/** Canonical stored value of custom property `key` of kind `kind`: text,
 *  "true"/"false", the number as a normalised decimal, the list item's RID,
 *  or ABSENT. A number's exact text from the read is used when it is a plain
 *  decimal; otherwise (an exponent or any other form) its numeric value. */
export function storedValue(obj: ReadShape, key: string, kind: PropertyKind): string {
  if (kind === 'listItem' || kind === 'reference' || kind === 'principal' || kind === 'referenceList') {
    const rids = ownValue(obj.references, key);
    if (!Array.isArray(rids)) return Object.hasOwn(obj.props, key) ? obj.props[key].text : ABSENT;
    return rids.length ? rids.join(',') : ABSENT;
  }
  if (!Object.hasOwn(obj.props, key)) return ABSENT;
  const v = obj.props[key];
  if (kind === 'boolean' || v.kind === 'boolean') return String(v.bool ?? v.text === 'true');
  if (kind === 'number') {
    const exact = normalizeDecimal(v.text.trim());
    if (exact != null) return exact;
    if (typeof v.num === 'number' && Number.isFinite(v.num)) return normalizeDecimal(plainNumber(v.num)) ?? v.text;
  }
  return v.text;
}

/**
 * The RIDs of a reference value in its canonical string form: one RID, the
 * RIDs of a list joined with commas, or ABSENT (nothing). The stored and
 * sent form keeps its order (the server's for a read, the user's for a
 * write: `LIST(…)` is written in that order); every comparison of a list
 * is by set (`sameReferences`), so order never counts as a change.
 */
export function referenceRids(value: string): string[] {
  return value === ABSENT || value === '' ? [] : value.split(',');
}

/** The canonical value of a list of RIDs (ABSENT for none). */
export function referenceValue(rids: readonly string[]): string {
  return rids.length ? rids.join(',') : ABSENT;
}

/** Whether two reference values hold the same RIDs, in any order. */
export function sameReferences(a: string, b: string): boolean {
  const x = new Set(referenceRids(a));
  const y = new Set(referenceRids(b));
  return x.size === y.size && [...x].every(r => y.has(r));
}

/** Whether the stored value equals what was sent, compared by kind:
 *  numbers as normalised decimals, booleans by truth, list items and single
 *  references by RID, lists of references as sets of RIDs, text exactly (an
 *  empty text may be stored as absent). Absent equals only absent. */
export function storedEquals(kind: EditKind, sent: string, stored: string): boolean {
  if (stored === ABSENT) return sent === ABSENT || ((kind === 'text' || kind === 'multiline') && sent === '');
  if (sent === ABSENT) return false;
  switch (kind) {
    case 'number': {
      const a = normalizeDecimal(sent.trim());
      return a != null && a === normalizeDecimal(stored.trim());
    }
    case 'boolean': return (sent === 'true') === (stored === 'true');
    case 'listItem':
    case 'reference':
    case 'principal': return sent === stored;
    case 'referenceList': return sameReferences(sent, stored);
    default: return sent === stored || ((kind === 'text' || kind === 'multiline') && sent.replace(/\r\n/g, '\n') === stored.replace(/\r\n/g, '\n'));
  }
}

// ── values and the write script ───────────────────────────────────────

/** Whole numbers: at most 18 digits (inside a Java long). */
const INTEGER_RE = /^-?\d{1,18}$/;
/** Decimals: digits, optionally a point and digits. No exponent, no
 *  grouping, no bare point (`.5`, `5.`, `-.5` are refused). */
const DECIMAL_RE = /^-?\d{1,18}(\.\d{1,15})?$/;
const RID_DIGITS = /^\d{1,20}$/;

/** A typed number, normalised, or an error in words. Only the plain form is
 *  accepted: "1,234" (a separator that could mean a thousand or a decimal
 *  point) and inner spaces are refused rather than guessed. */
export function parseNumberInput(input: string, integer: boolean): { value: string } | { error: string } {
  const t = input.trim();
  if (!t) return { error: 'Enter a number' };
  if (integer) {
    if (INTEGER_RE.test(t)) return { value: normalizeDecimal(t)! };
    if (/^-?\d+$/.test(t)) return { error: 'Too many digits' };
    return { error: /^-?\d+[.,]\d+$/.test(t) ? 'Enter a whole number' : 'Not a number' };
  }
  if (DECIMAL_RE.test(t)) return { value: normalizeDecimal(t)! };
  if (/^-?\d+,\d+$/.test(t)) return { error: 'Use a point as the decimal separator, without grouping' };
  return { error: /^-?\d+(\.\d+)?$/.test(t) ? 'Too many digits' : 'Not a number' };
}

/** A custom change as the window sends it and the gate checks it. */
export interface CustomChange {
  /** Definition RID (the read's key). */
  definition: string;
  /** EC accessor (the definition's business ID). */
  accessor: string;
  kind: EditKind;
  /** text / "true"|"false" / number text / list item RID. */
  value: string;
}

/** Characters a text value may not hold: NUL and the other C0 controls
 *  except tab, line feed and carriage return, DEL, and the line and paragraph
 *  separators. BMP's string literal is decoded with Java's JavaScript
 *  unescaper (ExtCalcVisitor.visit(ExtText)), and the lexer reads U+2028 and
 *  U+2029 as white space between tokens; none of them belongs in a value
 *  typed in a property row, so they are refused instead of relied on. */
function hasUnwritableChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** A text value as an EC string literal (ecString: backslash, quote, CR, LF
 *  and tab escaped), or an error when it holds an unwritable character.
 *  `${…}` is not escaped. ASSUMPTION, to be confirmed live: BMP does not
 *  interpolate `${…}` inside a string literal (token interpolation was seen
 *  only in the status function visitor). Live check: the value
 *  `a${1+1}b "q" \ end` must be sent as `"a${1+1}b \"q\" \\ end"` and read
 *  back unchanged. */
export function textLiteral(value: string): { rhs: string } | { error: string } {
  if (hasUnwritableChar(value)) return { error: 'The text holds a control character that cannot be saved' };
  return { rhs: ecString(value) };
}

/** The EC right-hand side of `value` for `kind`, or an error in words.
 *  `items`: allowed item RIDs of a list property, or the allowed object RIDs
 *  of a reference property (AllowedObjects of this object); `itemRef`: the
 *  reference form of an item or object RID (`lookup(<rid>)`, or the
 *  pre-lookup form of an older server from BmpClient.resolveRefs);
 *  `options`: allowed strings; `allowBlank`: the model's (may be "Not set").
 *  ABSENT ("Not set") of a list item or a single reference is a clear
 *  (`{ clear }`); of a list of references it is `LIST()`. A list of
 *  references is written in the order of `value`. */
export function encodeCustomValue(
  kind: EditKind,
  value: string,
  ctx: {
    integer?: boolean; items?: ReadonlySet<string>; options?: readonly string[]; itemRef?: (rid: string) => string | undefined; allowBlank?: boolean;
    /** Reference kinds: the definition is historical (a clear is refused with DATED_NO_CLEAR). */
    historical?: boolean;
  } = {},
): { rhs: string } | { clear: true } | { error: string } {
  if (typeof value !== 'string') return { error: 'The value is not text' };
  switch (kind) {
    case 'text':
      if (/[\r\n]/.test(value)) return { error: 'A single-line text cannot hold line breaks' };
      return textLiteral(value);
    case 'multiline':
      return textLiteral(value.replace(/\r\n/g, '\n'));
    case 'number': {
      const re = ctx.integer ? INTEGER_RE : DECIMAL_RE;
      if (!re.test(value)) return { error: ctx.integer ? 'Not a whole number' : 'Not a number' };
      return { rhs: normalizeDecimal(value)! };
    }
    case 'boolean':
      if (value !== 'true' && value !== 'false') return { error: 'Not On or Off' };
      return { rhs: value === 'true' ? 'TRUE' : 'FALSE' };
    case 'choice':
      if (!ctx.options?.includes(value)) return { error: 'Not one of the allowed values' };
      return textLiteral(value);
    case 'listItem': {
      if (value === ABSENT) return ctx.allowBlank ? { clear: true } : { error: 'This property cannot be left not set' };
      if (!RID_DIGITS.test(value)) return { error: 'Not an item RID' };
      if (!ctx.items?.has(value)) return { error: 'Not an item of this property’s list' };
      const ref = ctx.itemRef ? ctx.itemRef(value) : `lookup(${value})`;
      return ref ? { rhs: ref } : { error: 'The item could not be resolved on this server' };
    }
    case 'reference':
    case 'principal':
    case 'referenceList': {
      const list = kind === 'referenceList';
      if (value === ABSENT) {
        if (ctx.allowBlank) return list ? { rhs: 'LIST()' } : { clear: true };
        return { error: !list && ctx.historical ? DATED_NO_CLEAR : 'This property cannot be left not set' };
      }
      const rids = value.split(',');
      if (!list && rids.length > 1) return { error: 'This property holds one object only' };
      if (rids.some(r => !RID_DIGITS.test(r))) return { error: 'Not an object RID' };
      if (new Set(rids).size !== rids.length) return { error: 'An object is in the list twice' };
      if (rids.some(r => !ctx.items?.has(r))) return { error: NOT_ALLOWED_OBJECT };
      const refs: string[] = [];
      for (const r of rids) {
        const ref = ctx.itemRef ? ctx.itemRef(r) : `lookup(${r})`;
        if (!ref) return { error: 'The object could not be resolved on this server' };
        refs.push(ref);
      }
      return { rhs: list ? `LIST(${refs.join(', ')})` : refs[0] };
    }
  }
  return { error: 'Unsupported kind' };
}

/** One `change()` per property: one bad value then cannot take the
 *  others with it inside a single call. */
export function changeLine(objectVar: string, accessor: string, rhs: string): string {
  validateEcIdentifier(objectVar);
  return `${objectVar}.change(${validateEcIdentifier(accessor)} := ${rhs})`;
}

/** The clear of a property ("Not set"): `clear(<accessor>)` removes its
 *  stored value. Confirmed live for a single list item (ListMethodConfig,
 *  BMP 5.6.17), and for a single reference it is the only form that empties
 *  it (`NONE`, `EMPTY`, `NULL` write nothing while the server answers ok).
 *  The read after the save still decides whether it is saved
 *  (the property must read as not set), so a clear the server does not take
 *  is reported "not stored as sent", never as saved. */
export function clearLine(objectVar: string, accessor: string): string {
  validateEcIdentifier(objectVar);
  return `${objectVar}.clear(${validateEcIdentifier(accessor)})`;
}

/**
 * The write of a historical value at an effective date (switch ON only).
 * Measured from the server code: `calculate(expr, d1, d2)` runs `expr` in a
 * context from d1 to d2 without rounding, and a historical custom value is
 * stored at the context START (d1), replacing an entry at exactly that
 * instant and otherwise adding one. `isoDate` is YYYY-MM-DD.
 */
export function historicalChangeLine(objectVar: string, accessor: string, rhs: string, isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`Invalid date: ${isoDate}`);
  validateEcIdentifier(objectVar);
  const d = `date("${isoDate}")`;
  return `${objectVar}.calculate(self.change(${validateEcIdentifier(accessor)} := ${rhs}), ${d}, ${d})`;
}

/** The reference of a list item on a server without `lookup()`: the form
 *  BmpClient.resolveRefs builds from the item's business ID (a test pins the
 *  two against each other). Used only to size a write. */
export function legacyItemRef(rid: string, businessId: string): string {
  const ref = `${resolveNamespace(LIST_ITEM_TYPE)}.get("${formatEcLiteral(businessId)}")`;
  return `LIST(${ref}).filter(str(rid) = "${rid}").first().whenMissing(error("BMP object identity no longer matches RID ${rid}; refresh the object"))`;
}
const LIST_ITEM_TYPE = 'ListPropertySetItem';

/** Size of one change line as the gate generates it (for splitting a save
 *  across posts): the real `_o.change(<accessor> := <value>)` text. A list
 *  item counts with the longer of its two reference forms (`lookup(<rid>)`,
 *  or the pre-lookup form built from `itemId`, the item's business ID).
 *  Only when that text cannot be built (an item whose business ID is not
 *  known, a value or accessor the gate refuses anyway) an upper estimate is
 *  used. Historical lines (switch off) are not sized.
 *
 *  Reference kinds: `itemId` is a function from an object RID to its
 *  business ID (from the allowed objects). Each object counts with the
 *  longer of `lookup(<rid>)` and the pre-lookup form, whose namespace is
 *  not known here: counted as REFERENCE_NAMESPACE_MAX characters. An object
 *  whose business ID is not known counts REFERENCE_SIZE_UNKNOWN. */
export function changeLineSize(c: Pick<CustomChange, 'accessor' | 'value' | 'kind'>, itemId?: string | ((rid: string) => string | undefined)): number {
  if (isReferenceKind(c.kind)) return referenceLineSize(c, typeof itemId === 'function' ? itemId : () => undefined);
  const id = typeof itemId === 'string' ? itemId : undefined;
  const itemRef = (rid: string) => {
    const lookup = `lookup(${rid})`;
    const legacy = id !== undefined ? legacyItemRef(rid, id) : '';
    return legacy.length > lookup.length ? legacy : lookup;
  };
  if (c.kind === 'listItem' && c.value === ABSENT) {
    try { return clearLine('_o', c.accessor).length; } catch { /* estimate below */ }
  } else if (c.kind !== 'listItem' || id !== undefined) {
    const enc = encodeCustomValue(c.kind, c.value, { items: new Set([c.value]), options: [c.value], itemRef });
    if ('rhs' in enc) {
      try { return changeLine('_o', c.accessor, enc.rhs).length; } catch { /* estimate below */ }
    }
  }
  // ecString escapes at most double the text; 40 covers `_o.change( := )` and quotes.
  const value = typeof c.value === 'string' ? c.value : '';
  return c.accessor.length + 40 + (c.kind === 'text' || c.kind === 'multiline' || c.kind === 'choice' ? value.length * 2 : c.kind === 'listItem' ? 400 : value.length + 10);
}

/** Characters a type's EC namespace (`resolveNamespace`) is counted with
 *  when the pre-lookup reference of an object of unknown type is sized. */
export const REFERENCE_NAMESPACE_MAX = 64;
/** Characters one object of a reference value counts when its business ID
 *  is not known (an upper estimate of the pre-lookup form). */
export const REFERENCE_SIZE_UNKNOWN = 400;

/** changeLineSize of a reference kind: the clear, or the change with each
 *  object at its longer reference form. A value the gate refuses anyway
 *  (no RID, a bad accessor) gets an upper estimate. */
function referenceLineSize(c: Pick<CustomChange, 'accessor' | 'value' | 'kind'>, idOf: (rid: string) => string | undefined): number {
  const value = typeof c.value === 'string' ? c.value : '';
  const rids = referenceRids(value);
  const refSize = (rid: string) => {
    const id = idOf(rid);
    if (id === undefined) return Math.max(`lookup(${rid})`.length, REFERENCE_SIZE_UNKNOWN);
    // legacyItemRef with the list-item namespace swapped for the longest one counted.
    const legacy = legacyItemRef(rid, id).length - resolveNamespace(LIST_ITEM_TYPE).length + REFERENCE_NAMESPACE_MAX;
    return Math.max(`lookup(${rid})`.length, legacy);
  };
  try {
    if (value === ABSENT && c.kind !== 'referenceList') return clearLine('_o', c.accessor).length;
    // `_o.change(<accessor> := LIST(a, b))`: the frame, then each object and its separator.
    const frame = changeLine('_o', c.accessor, c.kind === 'referenceList' ? 'LIST()' : '').length;
    return frame + rids.reduce((n, r, i) => n + refSize(r) + (i ? 2 : 0), 0);
  } catch {
    return c.accessor.length + 40 + Math.max(1, rids.length) * REFERENCE_SIZE_UNKNOWN;
  }
}

/** Head room per script for `_o := lookup(<rid>)` and the transport. */
export const SCRIPT_HEAD = 200;
