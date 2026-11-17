/**
 * Service worker: the property schema of a type (cached per server profile
 * for the connection), and the gate every custom property write passes.
 *
 * Schema = the type's field description (GetTypeFieldsCommand), the class
 * and list set of each custom property's definition (one batched object
 * read), and the items of each list set (one constant script per set, the
 * set as context, all sets in one post). Reads only: built-in commands and
 * constant scripts.
 *
 * Gate (`checkCustomChanges`): for an object of type T, a change is written
 * only when T's description lists the definition as a custom field with the
 * same accessor, the model (property-schema.ts) says it is editable and of
 * the sent kind, and the value fits that kind (a list item must be a child
 * of that definition's list set; a reference, user/group or list of
 * references must hold only objects of the allowed set the caller read for
 * this object just before, each once; a list may also keep the objects it
 * holds now). Values are encoded with the EC
 * guards; one `change()` per property. The window cannot widen any of this.
 */

import type { BmpClient } from './bmp-client';
import {
  allowedSourceOf, builtinNamesOf, classifyModel, clearLine, encodeCustomValue, changeLine, HISTORICAL_CUSTOM_WRITES, isEditKind, isReferenceKind,
  LIST_ITEMS_MAX, MAX_CUSTOM_CHANGES, ownValue, REASON_TEXT, REFERENCE_CLASSES, SCRIPT_HEAD, VALID_TYPE_NAME,
  type AllowedObjects, type AllowedSource, type CustomChange, type DefinitionFacts, type ListItem, type TypePropertySchema,
} from './property-schema';
import { SCRIPT_LIMITS } from './script-kinds';

export type SchemaClient = Pick<BmpClient, 'fetchTypeFieldDescriptions' | 'readFullObjects' | 'readListItems' | 'sessionEpoch'>
  & Partial<Pick<BmpClient, 'readListItemSets'>>;

const VALID_TYPE = VALID_TYPE_NAME;

/** How long a schema read in this session stands for the write gate. Older
 *  ones are read again before a write; the window's own display keeps the
 *  schema for the connection. */
export const GATE_SCHEMA_MAX_AGE_MS = 10 * 60_000;

interface CachedSchema { load: Promise<TypePropertySchema>; at: number }
interface ClientCache { epoch: number; byType: Map<string, CachedSchema> }
const caches = new WeakMap<object, ClientCache>();

function cacheOf(client: SchemaClient): ClientCache {
  let c = caches.get(client);
  // A new session (reconnect, sign-in again) drops what the old one read.
  if (!c || c.epoch !== client.sessionEpoch) {
    c = { epoch: client.sessionEpoch, byType: new Map() };
    caches.set(client, c);
  }
  return c;
}

/** The items of several list sets: one post when the client can (one
 *  constant script per set, each answered on its own), otherwise one read
 *  per set. A set whose read failed maps to its Error. */
async function readSets(client: SchemaClient, sets: readonly string[], signal?: AbortSignal): Promise<Map<string, ListItem[] | Error>> {
  if (client.readListItemSets && sets.length > 1) return client.readListItemSets(sets, signal);
  const out = new Map<string, ListItem[] | Error>();
  for (const s of sets) {
    try { out.set(s, await client.readListItems(s, signal)); }
    catch (e) { out.set(s, e instanceof Error ? e : new Error(String(e))); }
  }
  return out;
}

/** A boolean property of a definition read: true, false, or undefined when
 *  the read does not hold it. */
function flagOf(v: { text: string; bool?: boolean } | undefined): boolean | undefined {
  if (!v) return undefined;
  if (typeof v.bool === 'boolean') return v.bool;
  return v.text === 'true' ? true : v.text === 'false' ? false : undefined;
}

/** Whether a definition class is one of the reference classes. */
function isReferenceClass(configClass: string): boolean {
  return Object.hasOwn(REFERENCE_CLASSES, configClass.split('.').pop() ?? '');
}

/** Build the schema of `type` from the server (no cache). */
export async function readTypeSchema(client: SchemaClient, type: string, signal?: AbortSignal): Promise<TypePropertySchema> {
  if (!VALID_TYPE.test(type)) throw new Error(`Invalid type: ${type}`);
  const fields = await client.fetchTypeFieldDescriptions(type, signal);
  const defRids = [...new Set(fields.filter(f => f.customField && /^\d+$/.test(f.id)).map(f => f.id))];
  const definitions: Record<string, DefinitionFacts> = {};
  const listItems: Record<string, ListItem[]> = {};
  const unreadDefinitions: Record<string, string> = {};
  const listTooLong: Record<string, number> = {};
  if (defRids.length) {
    try {
      const { objects, errors } = await client.readFullObjects(defRids, signal);
      for (const rid of defRids) {
        const o = ownValue(objects, rid);
        if (!o) { unreadDefinitions[rid] = ownValue(errors, rid) ?? 'Definition not found'; continue; }
        const set = ownValue(o.references, 'listPropertySet')?.[0];
        const blank = flagOf(ownValue(o.props, 'allowBlank'));
        const reference = isReferenceClass(o.type);
        const required = reference ? flagOf(ownValue(o.props, 'required')) : undefined;
        const multiselect = reference ? flagOf(ownValue(o.props, 'multiselect')) : undefined;
        // Selection roots read as a display text of names ("" when none; an
        // empty list text counts as none).
        const roots = reference ? (ownValue(o.props, 'selectionRoots')?.text ?? '').trim() : '';
        definitions[rid] = {
          configClass: o.type,
          ...(set && /^\d+$/.test(set) ? { listSetRid: set } : {}),
          ...(blank === true ? { allowBlank: true } : blank === false && reference ? { allowBlank: false } : {}),
          ...(required ? { required: true } : {}),
          ...(multiselect !== undefined ? { multiselect } : {}),
          ...(reference && (ownValue(o.props, 'expression')?.text ?? '').trim() ? { hasExpression: true } : {}),
          ...(roots && roots !== '[]' ? { hasSelectionRoots: true } : {}),
          ...(reference && flagOf(ownValue(o.props, 'filtered')) === true ? { filtered: true } : {}),
        };
      }
    } catch (e) {
      for (const rid of defRids) unreadDefinitions[rid] = e instanceof Error ? e.message : String(e);
    }
    const lists = fields.flatMap(f => {
      const set = ownValue(definitions, f.id)?.listSetRid;
      return f.customField && f.type === 'ListPropertySetItem' && set ? [{ id: f.id, set }] : [];
    });
    const read = lists.length ? await readSets(client, [...new Set(lists.map(l => l.set))], signal) : new Map<string, ListItem[] | Error>();
    for (const { id, set } of lists) {
      const items = read.get(set) ?? new Error('No answer');
      if (items instanceof Error) {
        unreadDefinitions[id] = `The list items could not be read: ${items.message}`;
        continue;
      }
      // A list longer than the editor offers is cut and its row read-only
      // (classifyField: "The list is too long to choose from here").
      if (items.length > LIST_ITEMS_MAX) listTooLong[id] = items.length;
      listItems[id] = items.slice(0, LIST_ITEMS_MAX);
    }
  }
  return {
    type, fields, definitions, listItems,
    ...(Object.keys(unreadDefinitions).length ? { unreadDefinitions } : {}),
    ...(Object.keys(listTooLong).length ? { listTooLong } : {}),
  };
}

/** The schema of `type`, read once per connection of this profile's client.
 *  `refresh` reads it again (and replaces the cached one); `maxAgeMs` reads
 *  it again only when the cached one was read longer ago than that. */
export function typeSchema(client: SchemaClient, type: string, opts: { refresh?: boolean; maxAgeMs?: number; signal?: AbortSignal; now?: () => number } = {}): Promise<TypePropertySchema> {
  const cache = cacheOf(client);
  const key = type.toLowerCase();
  const now = (opts.now ?? Date.now)();
  const cached = cache.byType.get(key);
  if (cached && !opts.refresh && (opts.maxAgeMs === undefined || now - cached.at <= opts.maxAgeMs)) return cached.load;
  const load = readTypeSchema(client, type, opts.signal);
  const entry: CachedSchema = { load, at: now };
  cache.byType.set(key, entry);
  load.catch(() => { if (cache.byType.get(key) === entry) cache.byType.delete(key); });
  return load;
}

/** Test hook. */
export function forgetSchemas(client: SchemaClient): void { caches.delete(client); }

export interface GateRefusal { definition: string; reason: string }
export type GateResult =
  | { ok: true; lines: string[] }
  | { ok: false; refused: GateRefusal[] };

/** Why a reference change cannot be checked against its allowed objects:
 *  the read is missing or failed. */
export const ALLOWED_UNREAD = 'The objects this property allows could not be read';

/** Whether `definition` is an editable reference property of the schema's
 *  type (custom; its definition has an expression, or names its allowed
 *  types without roots or a filter): the only definitions whose allowed
 *  objects are read. */
export function isEditableReference(schema: TypePropertySchema, definition: unknown): boolean {
  return editableReferenceSource(schema, definition) !== undefined;
}

/** Where the allowed objects of editable reference property `definition`
 *  come from (AllowedSource), from the schema alone; undefined when it is
 *  not an editable reference of the schema's type. */
export function editableReferenceSource(schema: TypePropertySchema, definition: unknown): AllowedSource | undefined {
  if (typeof definition !== 'string' || !/^\d{1,20}$/.test(definition)) return undefined;
  const field = schema.fields.find(f => f.id === definition && f.customField === true);
  if (!field) return undefined;
  const model = classifyModel(schema, field);
  if (!isReferenceKind(model.kind) || !model.editability.ok) return undefined;
  return allowedSourceOf(field, ownValue(schema.definitions, definition));
}

/** The sources of `definitions` (editable references only), for
 *  BmpClient.readAllowedObjectSets: by-type ones carry their type names. */
export function allowedSources(schema: TypePropertySchema, definitions: readonly string[]): Map<string, AllowedSource> {
  const out = new Map<string, AllowedSource>();
  for (const d of definitions) {
    const source = editableReferenceSource(schema, d);
    if (source) out.set(d, source);
  }
  return out;
}

/** The definitions of the reference changes in a post, each once, whose
 *  allowed objects the gate needs: editable references of the schema's type
 *  sent with their own kind. Others are refused by the gate without a read. */
export function referenceDefinitions(schema: TypePropertySchema, changes: readonly CustomChange[]): string[] {
  const out = new Set<string>();
  if (!Array.isArray(changes)) return [];
  for (const c of changes) {
    if (typeof c?.kind !== 'string' || !isReferenceKind(c.kind) || !isEditableReference(schema, c.definition)) continue;
    out.add(c.definition);
  }
  return [...out];
}

/**
 * Check every change against the schema of the object's own type and build
 * the change lines. All or nothing: one refused change refuses the post, and
 * every refused change is named with its own reason (a bad value never
 * hides the others' verdicts). Historical properties are written with a
 * plain change like the others (HISTORICAL_CUSTOM_WRITES); `effectiveDate`
 * is accepted and not used.
 */
export function checkCustomChanges(
  schema: TypePropertySchema,
  changes: readonly CustomChange[],
  opts: {
    historicalWrites?: boolean; effectiveDate?: string; limit?: number;
    /** Reference form of a list item or object RID (BmpClient.resolveRefs:
     *  lookup() or the pre-lookup form of an older server). Default:
     *  lookup(<rid>). */
    itemRef?: (rid: string) => string | undefined;
    /** Definition RID → the objects that reference property allows for THIS
     *  object, read just before the write (never a cached copy: the set
     *  depends on the object's current data), or the Error of that read. A
     *  reference change without an entry is refused (ALLOWED_UNREAD). */
    allowed?: ReadonlyMap<string, AllowedObjects | Error>;
    /** Definition RID → the object RIDs the object holds for that property
     *  now (its read). Lists of references only: a stored object may stay in
     *  the list although the property no longer allows it; only objects
     *  being added must be allowed. */
    stored?: ReadonlyMap<string, readonly string[]>;
  } = {},
): GateResult {
  const refused: GateRefusal[] = [];
  const lines: string[] = [];
  const seen = new Set<string>();
  const historicalWrites = opts.historicalWrites ?? HISTORICAL_CUSTOM_WRITES;
  if (!Array.isArray(changes) || !changes.length) return { ok: false, refused: [{ definition: '', reason: 'No changes were sent.' }] };
  if (changes.length > MAX_CUSTOM_CHANGES) return { ok: false, refused: [{ definition: '', reason: `At most ${MAX_CUSTOM_CHANGES} changes per write.` }] };
  const builtinNames = builtinNamesOf(schema);
  for (const c of changes) {
    const definition = typeof c?.definition === 'string' ? c.definition : '';
    const refuse = (reason: string) => refused.push({ definition, reason });
    if (!/^\d{1,20}$/.test(definition)) { refuse('Not a property definition RID.'); continue; }
    if (seen.has(definition)) { refuse('The property is changed twice.'); continue; }
    seen.add(definition);
    const field = schema.fields.find(f => f.id === definition);
    if (!field) { refuse(`Not a property of ${schema.type}.`); continue; }
    if (!field.customField) { refuse('Not a custom property.'); continue; }
    if (typeof c.accessor !== 'string' || c.accessor !== field.businessId) { refuse('The accessor does not match the property definition.'); continue; }
    const model = classifyModel(schema, field, { historicalWrites, builtinNames });
    if (!model.editability.ok) { refuse(model.editability.text); continue; }
    if (typeof c.kind !== 'string' || !isEditKind(c.kind) || c.kind !== model.kind) { refuse('The value kind does not match the property.'); continue; }
    const reference = isReferenceKind(c.kind);
    let items: Set<string> | undefined;
    if (c.kind === 'listItem') items = new Set((ownValue(schema.listItems, definition) ?? []).map(i => i.rid));
    else if (reference) {
      const read = opts.allowed?.get(definition);
      if (!read) { refuse(`${ALLOWED_UNREAD}.`); continue; }
      if (read instanceof Error) { refuse(`${ALLOWED_UNREAD}: ${read.message}`); continue; }
      if (read.tooMany) { refuse(REASON_TEXT['list-too-long']); continue; }
      items = new Set(read.items.map(i => i.rid));
      // A list keeps what it holds: only added objects must be allowed.
      if (c.kind === 'referenceList') for (const r of opts.stored?.get(definition) ?? []) items.add(r);
    }
    const enc = encodeCustomValue(c.kind, c.value, {
      integer: model.integer, items, options: model.options, allowBlank: model.allowBlank, historical: model.historical,
      ...(opts.itemRef ? { itemRef: opts.itemRef } : {}),
    });
    if ('error' in enc) { refuse(enc.error); continue; }
    try {
      if ('clear' in enc) {
        // "Not set" of a list item or single reference that may be blank
        // (never historical: a clear would remove every dated value).
        if (model.historical) { refuse('Historical value: editing comes next'); continue; }
        lines.push(clearLine('_o', field.businessId));
      } else {
        // A plain change, also on a Historical definition: it takes effect
        // from the moment of the write.
        lines.push(changeLine('_o', field.businessId, enc.rhs));
      }
    } catch (e) {
      refuse(e instanceof Error ? e.message : String(e));
    }
  }
  if (refused.length) return { ok: false, refused };
  const limit = (opts.limit ?? SCRIPT_LIMITS.user) - SCRIPT_HEAD;
  const size = lines.reduce((n, l) => n + l.length + 1, 0);
  if (size > limit) return { ok: false, refused: [{ definition: '', reason: `The change is too large for one write (${size} characters, at most ${limit}).` }] };
  return { ok: true, lines };
}
