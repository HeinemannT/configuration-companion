/**
 * Field descriptions in the shape GetTypeFieldsCommand returns them (one
 * FieldDto per field). Names and RIDs are synthetic. Custom fields: a list item, a list of references, a user
 * reference, a boolean, plus a text, a number and a multi-line text in the
 * same shape. Built-ins: one each of the kinds the gate must refuse.
 */
import { parseFieldDescription as parseFieldDescriptionNow, type DefinitionFacts, type FieldDescription, type ListItem, type TypePropertySchema } from '../../property-schema';
import type { PropValue } from '../../object-read';

export const DEF = {
  kind: '7000000000000000010',
  regions: '7000000000000000011',
  owner: '7000000000000000012',
  enabled: '7000000000000000013',
  note: '7000000000000000001',
  weight: '7000000000000000002',
  summary: '7000000000000000003',
  score: '7000000000000000004',
  locked: '7000000000000000005',
  secret: '7000000000000000006',
  review: '7000000000000000007',
  body: '7000000000000000008',
} as const;

const LOC = ['DETAILED', 'CSPROP', 'DESCRIPTIONVIEW', 'WEBTABLE', 'FILTERTABLE', 'TAG', 'CSDIALOG', 'WEBEDITOR', 'WEBSEARCH'];

/** Raw FieldDto values as the binary reader deserialises them. */
export const RAW_FIELDS: unknown[] = [
  { $class: 'com.corporater.bmp.dto.command.type.FieldDto', readOnly: true, sortIndex: 1, businessId: 'rid', category: '#L#Referrable.rid.category', displayName: '#L#Referrable.rid.displayName', id: 'rid', name: 'rid', methodVisibility: { name: 'VISIBLE' }, type: { $class: 'com.corporater.base.generation.system.TypeKey', typeId: 'Rid' }, locationsWhereVisible: { $elements: [{ name: 'TAG' }] } },
  { $class: 'FieldDto', editable: true, sortIndex: 4, businessId: 'description', category: '#L#BusinessTreeObject.description.category', displayName: '#L#BusinessTreeObject.description.displayName', id: 'description', name: 'description', type: { typeId: 'String' }, rich: true, expert: { $class: 'FieldDto$ExpertDto', cs: true, web: false } },
  {
    $class: 'FieldDto', choice: true, customField: true, editable: true, reference: true, sortIndex: 39, businessId: 'kind', category: 'Identity', description: '', displayName: 'Kind',
    id: DEF.kind, name: DEF.kind, methodVisibility: { name: 'NOTVISIBLE' }, type: { typeId: 'ListPropertySetItem' },
    options: { $class: 'java.util.ArrayList', $elements: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'] }, locationsWhereVisible: { $elements: LOC.map(name => ({ name })) },
  },
  {
    $class: 'FieldDto', customField: true, editable: true, multiselect: true, reference: true, sortIndex: 40, businessId: 'regions', category: '#L#defaultTypes.misc', displayName: 'Relevant regions',
    id: DEF.regions, name: DEF.regions, type: { typeId: 'List' }, collectionType: { typeId: 'BusinessTreeObject' },
    referenceConstraints: { $class: 'FieldDto$ReferenceConstraintsDto', advanced: true, allowBlank: true, allowOnlyExactClass: true, allowedTypes: [], filter: '', selectionRoots: '', sourceExpression: 'root.organisation.descendants(Organisation).filter(inScope)' },
  },
  {
    $class: 'FieldDto', customField: true, editable: true, reference: true, sortIndex: 41, businessId: 'owner', category: '#L#defaultTypes.misc', displayName: 'Owner',
    id: DEF.owner, name: DEF.owner, type: { typeId: 'BusinessTreeObject' }, collectionType: { typeId: 'BusinessTreeObject' },
    referenceConstraints: { advanced: true, allowBlank: true, allowedTypes: { $elements: [] }, sourceExpression: 'root.user.children(User).filter(inactive = false)' },
  },
  { $class: 'FieldDto', calculated: false, customField: true, editable: true, hidden: false, historical: false, readOnly: false, sortIndex: 42, businessId: 'enabled', category: '#L#defaultTypes.misc', displayName: 'Enabled', id: DEF.enabled, name: DEF.enabled, type: { typeId: 'Boolean' } },
  { $class: 'FieldDto', customField: true, editable: true, sortIndex: 10, businessId: 'note', category: 'Identity', displayName: 'Note', id: DEF.note, name: DEF.note, type: { typeId: 'String' }, multilineStyle: '' },
  { $class: 'FieldDto', customField: true, editable: true, sortIndex: 43, businessId: 'weight', category: 'Scoring', displayName: 'Weight', id: DEF.weight, name: DEF.weight, type: { typeId: 'Double' } },
  { $class: 'FieldDto', customField: true, editable: true, sortIndex: 44, businessId: 'summary', category: 'Scoring', displayName: 'Summary', id: DEF.summary, name: DEF.summary, type: { typeId: 'String' }, multilineStyle: 'MULTILINE' },
  { $class: 'FieldDto', customField: true, editable: false, calculated: true, sortIndex: 45, businessId: 'score', category: 'Scoring', displayName: 'Score', id: DEF.score, name: DEF.score, type: { typeId: 'Double' } },
  { $class: 'FieldDto', customField: true, editable: true, readOnly: true, sortIndex: 46, businessId: 'locked', category: 'Scoring', displayName: 'Locked', id: DEF.locked, name: DEF.locked, type: { typeId: 'String' } },
  { $class: 'FieldDto', customField: true, editable: true, hidden: true, sortIndex: 47, businessId: 'secret', category: 'Scoring', displayName: 'Secret', id: DEF.secret, name: DEF.secret, type: { typeId: 'String' } },
  { $class: 'FieldDto', customField: true, editable: true, sortIndex: 48, businessId: 'review', category: '', displayName: 'Next review', id: DEF.review, name: DEF.review, type: { typeId: 'CorpoTime' } },
  { $class: 'FieldDto', customField: true, editable: true, rich: true, sortIndex: 49, businessId: 'body', category: '', displayName: 'Body', id: DEF.body, name: DEF.body, type: { typeId: 'String' } },
  { $class: 'FieldDto', editable: true, sortIndex: 22, businessId: 'showToolMenu', category: '#L#HasToolsMenu.showToolMenu.category', displayName: '#L#x', id: 'showToolMenu', name: 'showToolMenu', type: { typeId: 'boolean' } },
];

export const LIST_SET = '7100000000000000001';
export const OTHER_SET = '7100000000000000002';
export const ITEMS: ListItem[] = [
  { rid: '7200000000000000001', id: 'kind_first', name: 'First' },
  { rid: '7200000000000000002', id: 'kind_second', name: 'Second' },
  { rid: '7200000000000000003', id: 'kind_third', name: 'Third' },
  { rid: '7200000000000000004', id: 'kind_fourth', name: 'Fourth' },
  { rid: '7200000000000000005', id: 'kind_fifth', name: 'Fifth' },
  { rid: '7200000000000000006', id: 'kind_sixth', name: 'Sixth' },
];
/** An item of another list set (must be refused for `kind`). */
export const FOREIGN_ITEM = '7299999999999999999';

export const DEFINITIONS: Record<string, DefinitionFacts> = {
  [DEF.kind]: { configClass: 'ListMethodConfig', listSetRid: LIST_SET },
  // References whose definition has an expression (editable, dated).
  [DEF.regions]: { configClass: 'HistoricalReferenceMethodConfig', multiselect: true, hasExpression: true },
  [DEF.owner]: { configClass: 'HistoricalReferenceMethodConfig', multiselect: false, allowBlank: true, hasExpression: true },
  [DEF.enabled]: { configClass: 'HistoricalBooleanMethodConfig' },
  [DEF.note]: { configClass: 'TextMethodConfig' },
  [DEF.weight]: { configClass: 'NumberMethodConfig' },
  [DEF.summary]: { configClass: 'TextMethodConfig' },
  [DEF.score]: { configClass: 'ExtendedMethodConfig' },
  [DEF.locked]: { configClass: 'TextMethodConfig' },
  [DEF.secret]: { configClass: 'TextMethodConfig' },
  [DEF.review]: { configClass: 'DateMethodConfig' },
  [DEF.body]: { configClass: 'TextMethodConfig' },
};

/** The objects the reference properties allow for the sample object (the
 *  definition's expression calculated on it). */
export const ALLOWED: Record<string, ListItem[]> = {
  [DEF.regions]: [
    { rid: '7500000000000000001', id: '110', name: 'Customer onboarding' },
    { rid: '7500000000000000002', id: '108', name: 'Supplier onboarding' },
    { rid: '7500000000000000003', id: '112', name: 'Partner onboarding' },
  ],
  [DEF.owner]: [
    { rid: '7600000000000000001', id: 'alice', name: 'Alice' },
    { rid: '7600000000000000002', id: 'bob', name: 'Bob' },
  ],
};
/** An object no reference property allows (must be refused). */
export const FOREIGN_OBJECT = '7599999999999999999';

/** The definition RID of a reference by type (BY_TYPE_FIELD, not in RAW_FIELDS). */
export const BY_TYPE_REF = '7000000000000000014';

/** A single reference whose definition has no expression ("by type"), in
 *  the shape measured: the field description names the types, the
 *  definition read does not. Kept out of RAW_FIELDS; `withByType` adds it. */
export const BY_TYPE_FIELD: unknown = {
  $class: 'FieldDto', customField: true, editable: true, reference: true, sortIndex: 50, businessId: 'procedure', category: '#L#defaultTypes.misc', displayName: 'Procedure',
  id: BY_TYPE_REF, name: BY_TYPE_REF, type: { typeId: 'BusinessTreeObject' }, collectionType: { typeId: 'BusinessTreeObject' },
  referenceConstraints: { $class: 'FieldDto$ReferenceConstraintsDto', advanced: false, allowBlank: true, allowOnlyExactClass: true, allowedTypes: { $elements: ['CeProcedure'] } },
};
export const BY_TYPE_DEFINITION: DefinitionFacts = { configClass: 'ReferenceMethodConfig', multiselect: false, allowBlank: true };
/** Every object of the allowed type. */
export const BY_TYPE_ALLOWED: ListItem[] = [
  { rid: '7700000000000000001', id: 'proc_a', name: 'Procedure A' },
  { rid: '7700000000000000002', id: 'proc_b', name: 'Procedure B' },
];

/** The props of a by-type definition object as the object read returns
 *  them (measured: `types`, `filter` and `expression` read as ""). */
export function byTypeDefinitionProps(over: Record<string, string> = {}): Record<string, PropValue> {
  const flag = (t: string): PropValue => ({ kind: 'boolean', text: t, bool: t === 'true' });
  const text = (t: string): PropValue => ({ kind: 'text', text: t });
  const p = { advanced: 'false', expression: '', types: '', selectionRoots: '', filtered: 'false', filter: '', filterExpression: '', multiselect: 'false', allowBlank: 'true', required: 'false', listDisplayType: 'SEARCH_ONLY', ...over };
  const flags = new Set(['advanced', 'filtered', 'multiselect', 'allowBlank', 'required']);
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, flags.has(k) ? flag(v) : text(v)]));
}

/** `s` with the by-type field and its definition added; `field` and `def`
 *  override parts of them. */
export function withByType(
  s: TypePropertySchema,
  over: { constraints?: Record<string, unknown>; def?: Partial<DefinitionFacts> } = {},
): TypePropertySchema {
  const raw = BY_TYPE_FIELD as { referenceConstraints: Record<string, unknown> };
  const f = parseFieldDescriptionSync({ ...raw, referenceConstraints: { ...raw.referenceConstraints, ...over.constraints } });
  return { ...s, fields: [...s.fields, f], definitions: { ...s.definitions, [BY_TYPE_REF]: { ...BY_TYPE_DEFINITION, ...over.def } } };
}

/** The props of a definition object as the object read returns them: the
 *  facts readTypeSchema takes (allowBlank, required, multiselect, expression). */
export function definitionProps(rid: string): Record<string, PropValue> {
  const d = DEFINITIONS[rid];
  const out: Record<string, PropValue> = {};
  if (!d) return out;
  const flag = (b: boolean): PropValue => ({ kind: 'boolean', text: String(b), bool: b });
  if (d.allowBlank !== undefined) out.allowBlank = flag(d.allowBlank);
  if (d.required !== undefined) out.required = flag(d.required);
  if (d.multiselect !== undefined) out.multiselect = flag(d.multiselect);
  if (d.hasExpression) out.expression = { kind: 'code', text: 'this.object.parent.children()' };
  return out;
}

function parseFieldDescriptionSync(raw: unknown): FieldDescription {
  const f = parseFieldDescriptionNow(raw);
  if (!f) throw new Error('fixture: not a field');
  return f;
}

export async function fields(): Promise<FieldDescription[]> {
  const { parseFieldDescription } = await import('../../property-schema');
  return RAW_FIELDS.map(parseFieldDescription).filter((f): f is FieldDescription => !!f);
}

export async function schema(type = 'CeProcess'): Promise<TypePropertySchema> {
  return { type, fields: await fields(), definitions: DEFINITIONS, listItems: { [DEF.kind]: ITEMS } };
}
