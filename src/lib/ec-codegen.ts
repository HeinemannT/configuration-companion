/**
 * Extended Code generation for the flow walker + object pane EC pipelines.
 *
 * The bmp-client.ts walkers used to construct EC by hand via 78 `lines.push()`
 * calls duplicating the same separator / pipe-row / forEach scaffolding. This
 * module owns the EC-building half of those methods so:
 *
 *   - The patterns ("emit a pipe-delimited identity row", "emit per-child EC
 *     for a property") live in ONE place. Adding a new field is one call,
 *     not a fresh `_r := _r + _sep + …` chain.
 *
 *   - bmp-client orchestrates round-trips (resolveRef → buildEc → executeEc →
 *     parseSepBlocks) and owns the result shape; this module is pure string
 *     construction with no I/O.
 *
 * Pure functions; safe to import from anywhere. The separator constant is
 * shared so callers parse with the same delimiter we emit.
 *
 * Rule (ec-code-safety): a property that can hold code is read only inside
 * `output(…)`. A bare read, a comparison or a WHERE/filter on it runs the
 * code on the server. `ec-code-safety.test.ts` checks every builder.
 */

import {
  ALL_CODE_FIELDS, ALL_REFERENCE_FIELDS, ALL_INDIRECT_FIELDS,
  ALL_CONTEXT_FIELDS, ALL_ENABLED_BY_PROPS,
} from './widget-metadata';
import type { PaneProp } from './bmp-client';
import { validateEcIdentifier } from './ec-guards';
import { scriptOn } from './script-kinds';
import { ecResolveTemplate } from './template-link';
import { appendBlockEc, appendRowEc, EC_DONE_LITERAL, STATIC_EC_FRAME, type EcFrame } from './ec-parser';

/** Legacy name of the walker separator. The walkers now answer in the
 *  length-framed rows of ec-parser (constant markers); kept for callers. */
export const FLOW_SEP = '~CREV_SEP~';

/** Max sibling rows emitted by the object-pane EC. The sibling navigator only
 *  needs a browseable slice; without this, an object under a parent with
 *  thousands of children paid O(N) per-child property reads + concat + payload
 *  on every pane open (the dominant cost behind "clicking an object is slow in
 *  this workspace"). We still count ALL children so the UI can show the true
 *  total — see `sibTotal` in buildObjectPaneEc / ObjectPaneData.siblingTotal. */
export const SIBLING_CAP = 50;

// ── Atom helpers ─────────────────────────────────────────────────

/** EC fragment that appends a framed `rid, id, name, className` row (used
 *  inside a {sep}list{sep} block). Framed rows keep names with `|` and line
 *  breaks intact (see EcFrame in ec-parser.ts). */
function identityRowNoKey(acc: string, varName: string, prefix = ''): string[] {
  return appendRowEc(acc, [`${varName}.rid.whenMissing("")`, `${varName}.id.whenMissing("")`, `${varName}.name.whenMissing("")`, `${varName}.className.whenMissing("")`], prefix);
}

/** `[label, value]` block row appended to `_r`; `labelExpr` is an EC string
 *  literal. */
function blockEc(labelExpr: string, valueExpr: string, prefix = ''): string[] {
  return appendRowEc('_r', [labelExpr, valueExpr], prefix);
}

/** Emit an EC content block (`{sep}<label>{sep}<value>\n`) ONLY when the value
 *  is non-empty. An empty property otherwise costs ~65 bytes on the wire — the
 *  sentinel twice + the label + a 19-digit RID — and MOST input/transport
 *  properties are empty (a typical field binds 0-1 of its 7 code props). On
 *  t.153 this shrank the per-child payload from ~1.3 KB to <100 bytes; the win
 *  scales linearly with field count. The value is read once via output() (raw
 *  text, no eval) and the parser already treats a missing block as "no EC", so
 *  nothing downstream changes. `labelExpr`/`valueExpr` are EC source fragments.
 *
 *  The value is coerced to a string (`"" + …`) BEFORE the `!= ""` guard. A bare
 *  `_v != ""` on a TYPED value (an enum like headerStyle/borderStyle, or a
 *  number like transparency) makes BMP coerce the literal `""` into that type
 *  and throw — e.g. `Valid choices for HeaderStyle is INSIDE, OUTSIDE, NONE`
 *  (verified live on t.5920). The pre-conditional codegen never hit this
 *  because it only ever CONCATENATED `output(…)` (string context); the `IF`
 *  guard introduced the comparison. `"" + output(…)` restores string context,
 *  so the guard is safe for every value type and the emitted text is unchanged. */
function condEcBlock(labelExpr: string, valueExpr: string, prefix = ''): string[] {
  return [
    `${prefix}_v := "" + ${valueExpr}`,
    `${prefix}IF _v != "" THEN`,
    ...blockEc(labelExpr, '_v', `${prefix}  `),
    `${prefix}ELSE`,
    `${prefix}  _r := _r`,
    `${prefix}ENDIF`,
  ];
}

/** Indirect EC block (Reference → ExtendedExpression): emit the content AND its
 *  backing-RID block (used for the Edit redirect) ONLY when the content is
 *  non-empty. Reading `.rid` only inside the non-empty branch also avoids a
 *  `.rid`-on-MISSING access when the reference is unset. */
function condIndirectEc(label: string, refExpr: string, targetProp = 'expression', prefix = ''): string[] {
  validateEcIdentifier(targetProp);
  return [
    `${prefix}_v := output(${refExpr}.${targetProp}.whenMissing(""))`,
    `${prefix}IF _v != "" THEN`,
    ...blockEc(`"${label}"`, '_v', `${prefix}  `),
    // Inside output(): a direct code property of that name reads as text
    // instead of running (ec-code-safety).
    ...blockEc(`"${label}_rid"`, `output(${refExpr}.rid.whenMissing(""))`, `${prefix}  `),
    `${prefix}ELSE`,
    `${prefix}  _r := _r`,
    `${prefix}ENDIF`,
  ];
}

/** Reference-edge blocks (rid|id|name|className), emitted only when the edge is
 *  set. Reads `_o.<rf>` once into `_ref` and emits the 4 blocks only if it
 *  resolves — saving 4 empty blocks per absent edge (most edges are absent for
 *  any given type) AND avoiding 4 reads on a MISSING reference. */
function condRefEc(rf: string): string[] {
  validateEcIdentifier(rf);
  return [
    `_ref := _o.${rf}`,
    'IF _ref != MISSING THEN',
    ...appendBlockEc('_r', `ref_${rf}_rid`, '_ref.rid.whenMissing("")', '  '),
    ...appendBlockEc('_r', `ref_${rf}_id`, '_ref.id.whenMissing("")', '  '),
    ...appendBlockEc('_r', `ref_${rf}_name`, '_ref.name.whenMissing("")', '  '),
    ...appendBlockEc('_r', `ref_${rf}_type`, '_ref.className.whenMissing("")', '  '),
    'ELSE',
    '  _r := _r',
    'ENDIF',
  ];
}

/** EC lines that emit a single header block `[label, value]`. */
function scalarBlock(label: string, valueExpr: string, prefix = ''): string[] {
  return appendBlockEc('_r', label, valueExpr, prefix);
}

// ── Common preamble / footer ─────────────────────────────────────

/** Standard EC closing — the accumulator and the completion marker. */
function footer(): string[] {
  return [`_r + ${EC_DONE_LITERAL}`];
}

// ── Object pane ──────────────────────────────────────────────────

/**
 * Resolve an EditField's string `propertyMapping` to the real property
 * configuration object. This deliberately does not use the generic reference
 * walker: propertyMapping is an accessor, not an object reference.
 *
 * ClassConfig children are per-class applications. Their `linkedTo` target is
 * the master property config under root.property, which is the stable object
 * the relationship chip opens. Owner-specific applications belong on the
 * Property view; this resolver returns only the stable master relationship.
 */
export function buildEditFieldPropertyEc(ref: string, classNames: readonly string[]): string {
  const classes = [...new Set(classNames)].sort();
  const lines = [
    `_o := ${ref}`,
    '_accessor := _o.propertyMapping.whenMissing("")',
    '_r := ""',
    '_done := FALSE',
    ...scalarBlock('accessor', '_accessor'),
  ];
  for (const className of classes) {
    validateEcIdentifier(className);
    lines.push('IF _done = FALSE THEN');
    lines.push(`  c.get(${className}.name).children().forEach(_app:`);
    lines.push('    IF _done = FALSE THEN');
    lines.push('      IF _app.linkedTo.id = _accessor THEN');
    lines.push('        _property := _app.linkedTo');
    lines.push(...scalarBlock('propertyRid', '_property.rid.whenMissing("MISSING")', '        '));
    lines.push(...scalarBlock('propertyId', '_property.id.whenMissing("")', '        '));
    lines.push(...scalarBlock('propertyName', '_property.name.whenMissing("")', '        '));
    lines.push(...scalarBlock('propertyType', '_property.className.whenMissing("")', '        '));
    lines.push('        _done := TRUE');
    lines.push('      ELSE');
    lines.push('        _r := _r');
    lines.push('      ENDIF');
    lines.push('    ELSE');
    lines.push('      _r := _r');
    lines.push('    ENDIF');
    lines.push('  )');
    lines.push('ELSE');
    lines.push('  _r := _r');
    lines.push('ENDIF');
  }
  lines.push(...footer());
  return scriptOn('buildEditFieldPropertyEc', ref, lines.join('\n'));
}

export const PROPERTY_APPLICATION_MARK = '<<<CREV_PROPERTY_APPLICATION>>>';
export const PROPERTY_APPLICATION_FIELD = '<<<CREV_PROPERTY_FIELD>>>';
export const PROPERTY_APPLICATION_END = '<<<CREV_PROPERTY_END>>>';
export const PROPERTY_APPLICATION_ERROR = '<<<CREV_PROPERTY_ERROR>>>';
export const PROPERTY_APPLICATION_TOTAL = '<<<CREV_PROPERTY_TOTAL>>>';
export const PROPERTY_APPLICATION_CAP = 100;

/** Capture every ClassConfig application of one master property in a single
 * reverse-reference pass. `application.genedit()` without `*` is the override delta:
 * inherited applications emit only their structural `id`, while overridden
 * applications emit the changed fields as well. */
export function buildPropertyApplicationsEc(ref: string): string {
  return scriptOn('buildPropertyApplicationsEc', ref, [
    `_property := ${ref}`,
    `_applications := _property.rref(linkedTo)`,
    `_total := _applications.size()`,
    `_result := "${PROPERTY_APPLICATION_TOTAL}" + str(_total)`,
    `_applications.first(${PROPERTY_APPLICATION_CAP}).forEach(_application:`,
    `  _genedit := _application.genedit()`,
    `  IF _genedit = "*<<<CREV_*" THEN`,
    `    _result := _result + "${PROPERTY_APPLICATION_ERROR}"`,
    `  ELSE`,
    `    _result := _result + "${PROPERTY_APPLICATION_MARK}" + _application.parent.id.whenMissing("") + "${PROPERTY_APPLICATION_FIELD}" + _application.rid.whenMissing("MISSING") + "${PROPERTY_APPLICATION_FIELD}" + _application.id.whenMissing("") + "${PROPERTY_APPLICATION_FIELD}" + _application.className.whenMissing("") + "${PROPERTY_APPLICATION_FIELD}" + _genedit`,
    `  ENDIF`,
    `)`,
    `_result := _result + "${PROPERTY_APPLICATION_END}"`,
    '_result',
  ].join('\n'));
}

/**
 * fetchObjectPane EC. Reads identity, parent, template, PANE_PROPS (style
 * props on inst + tmpl), every code field / reference edge / context value /
 * gate / list-ref across all types, plus the sibling list. Union approach
 * is intentional: missing properties return "" via whenMissing, and IF
 * guards skip the bodies of list-ref blocks for non-flow types — so non-flow
 * widgets pay only for the property reads, not the forEach overhead.
 */
export function buildObjectPaneEc(ref: string, paneProps: readonly string[], _frame: EcFrame = STATIC_EC_FRAME): string {
  const lines: string[] = [
    `_o := ${ref}`,
    // Widgets have a webParent; top-level portal objects (a Scorecard under an
    // Organisation) do not — fall back to the tree parent so Structure always
    // shows what is above (verified live: whenMissing works on object values).
    '_p := _o.webParent.whenMissing(_o.parent)',
    ...ecResolveTemplate('_o', '_t'),
    '_r := ""',
    ...scalarBlock('instRid', '_o.rid.whenMissing("MISSING")'),
    ...scalarBlock('instId', '_o.id.whenMissing("")'),
    ...scalarBlock('instName', '_o.name.whenMissing("")'),
    ...scalarBlock('instType', '_o.className.whenMissing("")'),
    ...scalarBlock('parRid', '_p.rid.whenMissing("MISSING")'),
    ...scalarBlock('parId', '_p.id.whenMissing("")'),
    ...scalarBlock('parName', '_p.name.whenMissing("")'),
    ...scalarBlock('parType', '_p.className.whenMissing("")'),
    ...scalarBlock('tmplRid', '_t.rid.whenMissing("MISSING")'),
    ...scalarBlock('tmplId', '_t.id.whenMissing("")'),
    ...scalarBlock('tmplName', '_t.name.whenMissing("")'),
    ...scalarBlock('tmplType', '_t.className.whenMissing("")'),
    // A ClassConfig application has the same *MethodConfig class but resolves
    // a linked master through ecResolveTemplate. Only the master definition
    // combines a MethodConfig class with no linked/template object.
    '_propertyMode := FALSE',
    'IF _t = MISSING THEN',
    '  IF _o.className.whenMissing("") = "*MethodConfig" THEN',
    '    _propertyMode := TRUE',
    '  ELSE',
    '    _propertyMode := FALSE',
    '  ENDIF',
    'ELSE',
    '  _propertyMode := FALSE',
    'ENDIF',
    ...scalarBlock('isPropertyDefinition', 'output(_propertyMode)'),
    'IF _propertyMode = FALSE THEN',
    // Effective detail card — the object's own `.card`, else (for enterprise
    // objects, whose instance `.card` is empty) the template's. `.card` is
    // null-safe in BMP (returns MISSING, never throws) for types without
    // HasCard — verified live across Container/FileResource/TextMethodConfig/
    // Organisation/Scorecard/CeRiskAssessment — so the eager `whenMissing` arg
    // (`_t.card`) can't blank the pane. Resolved here, after identity/parent/
    // template are emitted, so even a surprise failure leaves those intact.
    '_card := _o.card.whenMissing(_t.card)',
    ...scalarBlock('cardRid', '_card.rid.whenMissing("MISSING")'),
    ...scalarBlock('cardId', '_card.id.whenMissing("")'),
    ...scalarBlock('cardName', '_card.name.whenMissing("")'),
    ...scalarBlock('cardType', '_card.className.whenMissing("")'),
    ...scalarBlock('instCardRid', '_o.card.rid.whenMissing("")'),
  ];
  // Style props on instance + template — output() wrapper handles non-string
  // values (booleans, enums) which EC's bare-concat doesn't. Re-validate
  // every prop name even though they come from allowlists — slot-level
  // defence so corrupted metadata can't produce broken/hostile EC.
  // Every EAV slot below is emitted ONLY when non-empty (condEcBlock /
  // condRefEc / condIndirectEc). This union reads ~100 properties across all
  // types but any one object sets a handful — emitting the empty rest cost
  // ~65 bytes each (sentinel ×2 + label + 19-digit RID), i.e. multiple KB of
  // empty markers on every inspect. The parser already treats a missing block
  // as empty (`?? ''` / `if (v)`), so behaviour is identical. The identity /
  // parent / template / card blocks above stay unconditional — they use the
  // MISSING sentinel and parseIdentityBlock depends on their presence.
  for (const prop of paneProps) {
    validateEcIdentifier(prop);
    lines.push(...condEcBlock(`"inst_${prop}"`, `output(_o.${prop}.whenMissing(""))`));
    lines.push(...condEcBlock(`"tmpl_${prop}"`, `output(_t.${prop}.whenMissing(""))`));
  }
  // EditField.propertyMapping targets a property on the business-object type
  // configured by the CreateObjectView(s) that reference the parent EditPage.
  // Emit the owning classes once with the pane payload so the UI can reuse the
  // normal FETCH_TYPE_SCHEMA cache. A shared EditPage can have more than one
  // view, so keep every class; the picker intersects them client-side.
  lines.push(...editFieldTypesEc());
  lines.push(...condEcBlock('"editFieldTypes"', 'output(_editFieldTypes)'));
  // Code fields — union across all known types.
  for (const cf of ALL_CODE_FIELDS) {
    validateEcIdentifier(cf);
    lines.push(...condEcBlock(`"code_${cf}"`, `output(_o.${cf}.whenMissing(""))`));
  }
  // Reference edges — RID + business ID + name + className per edge.
  for (const rf of ALL_REFERENCE_FIELDS) {
    lines.push(...condRefEc(rf));
  }
  // Indirect code fields — Reference → ExtendedExpression.expression. The
  // backing reference rid (for the Edit redirect) rides along inside the same
  // conditional, so it's only emitted when the indirect EC actually exists.
  for (const ind of ALL_INDIRECT_FIELDS) {
    lines.push(...condIndirectEc(`ind_${ind.prop}_${ind.targetProp}`, `_o.${ind.prop}`, ind.targetProp));
  }
  // Context fields (enum / boolean) — list-ref handled separately below.
  for (const ctx of ALL_CONTEXT_FIELDS) {
    if (ctx.kind === 'list-ref') continue;
    lines.push(...condEcBlock(`"ctx_${ctx.prop}"`, `output(_o.${ctx.prop}.whenMissing(""))`));
  }
  // Gate values — booleans that control whether a code field is active.
  for (const eb of ALL_ENABLED_BY_PROPS) {
    lines.push(...condEcBlock(`"gate_${eb}"`, `output(_o.${eb}.whenMissing(""))`));
  }
  // List-ref context fields — iterate each list, emit pipe rows.
  for (const ctx of ALL_CONTEXT_FIELDS) {
    if (ctx.kind !== 'list-ref') continue;
    lines.push('_lr := ""');
    lines.push(`IF _o.${ctx.prop} != MISSING THEN`);
    lines.push(`  _o.${ctx.prop}.forEach(_i:`);
    lines.push(...identityRowNoKey('_lr', '_i', '    '));
    lines.push(`  )`);
    lines.push(`ENDIF`);
    lines.push(...scalarBlock(`list_${ctx.prop}`, '_lr'));
  }
  // Siblings — children of webParent. IF-guard means top-level objects (no
  // parent) skip the loop entirely; statement-form IF is the only flavor.
  // Capped at SIBLING_CAP rows: _sibN counts EVERY child (so `sibTotal` is the
  // true count for the UI), but the expensive per-child reads + row concat only
  // run for the first SIBLING_CAP. Avoids O(N) work + a huge payload when the
  // parent has thousands of children.
  lines.push('_sr := ""');
  lines.push('_curRid := _o.rid');
  lines.push('_sibN := 0');
  lines.push('IF _p != MISSING THEN');
  lines.push('  _p.children().forEach(_s:');
  lines.push('    _sibN := _sibN + 1');
  lines.push(`    IF _sibN <= ${SIBLING_CAP} THEN`);
  lines.push('      IF _s.rid = _curRid THEN');
  lines.push('        _cur := "1"');
  lines.push('      ELSE');
  lines.push('        _cur := "0"');
  lines.push('      ENDIF');
  lines.push(...appendRowEc('_sr', ['_s.rid.whenMissing("")', '_s.id.whenMissing("")', '_s.name.whenMissing("")', '_s.className.whenMissing("")', '_cur'], '      '));
  lines.push('    ENDIF');
  lines.push('  )');
  lines.push('ENDIF');
  // True total (all children, not just the emitted slice) so the navigator can
  // show "showing N of M". output() stringifies the number for bare concat.
  lines.push(...scalarBlock('siblings', '_sr'));
  lines.push(...scalarBlock('sibTotal', 'output(_sibN)'));
  lines.push('ENDIF');
  lines.push('IF _propertyMode = TRUE THEN');
  // The compact Property view consumes only these definition fields. Keep the
  // widget union, card resolution, relationship fields and sibling traversal
  // entirely outside this branch.
  for (const prop of ['description', 'category'] as const) {
    lines.push(...condEcBlock(`"inst_${prop}"`, `output(_o.${prop}.whenMissing(""))`, '  '));
  }
  lines.push(...condEcBlock('"code_expression"', 'output(_o.expression.whenMissing(""))', '  '));
  lines.push('ENDIF');
  lines.push(...footer());
  return scriptOn('buildObjectPaneEc', ref, lines.join('\n'));
}

export type { PaneProp };

/** EC lines that collect, for an EditField `_o`, the business-object classes
 *  its property mapping targets into `_editFieldTypes` (comma separated).
 *  The CreateObjectView(s) that reference the parent EditPage name the class;
 *  a shared EditPage can have more than one view, so every class is kept (the
 *  picker intersects them). A newly created or standalone EditPage may not be
 *  referenced yet: its own `types` are then the authoritative mapping surface,
 *  so a field is configurable right after Blueprint creates the page. */
export function editFieldTypesEc(): string[] {
  return [
    '_editFieldTypes := ""',
    'IF _o.className.whenMissing("") = "EditField" THEN',
    '  _o.parent.rref(editPage).forEach(_view:',
    '    _editFieldType := _view.objectType.className.whenMissing("")',
    '    IF _editFieldType <> "" THEN _editFieldTypes := _editFieldTypes + _editFieldType + "," ELSE _editFieldTypes := _editFieldTypes ENDIF',
    '  )',
    '  IF _editFieldTypes = "" THEN',
    '    _o.parent.types.forEach(_type:',
    '      _editFieldTypes := _editFieldTypes + output(_type) + ","',
    '    )',
    '  ELSE',
    '    _editFieldTypes := _editFieldTypes',
    '  ENDIF',
    'ENDIF',
  ];
}

/** Only the owning classes of an EditField (FETCH_EDIT_FIELD_TYPES): the
 *  object window's property-mapping picker needs nothing else of the pane. */
export function buildEditFieldTypesEc(ref: string): string {
  return scriptOn('buildEditFieldTypesEc', ref, [
    `_o := ${ref}`,
    ...editFieldTypesEc(),
    '_r := ""',
    ...scalarBlock('types', '_editFieldTypes'),
    ...footer(),
  ].join('\n'));
}
