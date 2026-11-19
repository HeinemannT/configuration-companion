/**
 * Every script builder, by kind (script-kinds.ts). BMP keeps a parse tree
 * per distinct script text in a cache of 2,000 entries, counted by entry and
 * not by size (about 40 bytes of heap per character), so:
 *
 *  - a CONSTANT builder gives the same text for every object, query, ID or
 *    date it is asked about (they travel in the command's context) and at
 *    most 25,000 characters; it may vary only with a small fixed choice
 *    (the code properties of a type, a page of an inventory);
 *  - a VARYING builder (the question is in the text) gives at most 1,200
 *    characters at its largest realistic input;
 *  - a USER builder (a write, or a read inside the user's own write) is the
 *    user's and only has the general 25,000 limit;
 *  - a FALLBACK builder writes the object into the text for a client without
 *    the context path (test doubles; BmpClient always has it); the transport
 *    refuses whatever of it is longer than a varying script may be.
 *
 * The test calls every builder with two different inputs, checks the kind the
 * builder marked, the limits, and that every exported builder in src/lib is
 * in the list. The transport refuses a script over its kind's limit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_OBJECT, EC_CHUNK, EC_FRAME, SCRIPT_TARGET_CHARS, chunkByScriptSize } from '../ec-parser';
import { classifyScript, constantScript, resetScriptKinds, SCRIPT_LIMITS, userScript, varyingScript } from '../script-kinds';
import { buildObjectPaneEc, buildEditFieldPropertyEc, buildPropertyApplicationsEc, buildEditFieldTypesEc } from '../ec-codegen';
import { buildContextRowFactsEc, buildRowFactsEc } from '../object-row-facts';
import { buildContextSummaryEc, buildSummariesEc } from '../object-summaries';
import { buildContextEnrichEc, buildBatchEnrichEc, buildContextCodeReadEc, buildBatchCodeReadEc, buildCodeReadEc, buildLayoutTreeEc, buildAccessSubjectsEc, buildColorSetsEc, EcQueryService } from '../ec-query-service';
import { buildCodeScopeEc, buildCodeScopeEcs } from '../code-search-scope';
import { buildContextReadEc, buildReadEc, buildRootListEc, buildCountEc, countGroups, buildBucketInventoryEc, buildSummaryEc, buildExistsEc, buildSampleEc, codeTypes, CODE_ROOTS, KNOWN_CODE_PROPS, orgBucket, rootBucket } from '../code-index-sync';
import { buildSourceListEc, buildSourceCodeEc, buildHitScanEcs } from '../code-scope-read';
import { buildContextRefResolveEc, buildRefResolveEc } from '../code-ref-resolve';
import { buildConnectionsEc, buildContextJunctionEc, buildInboundEc, buildInstancesEc, buildJunctionEc } from '../connections';
import { buildStructureEc, buildStructureEcMany } from '../object-structure';
import { buildAncestorsEc, idLookupPlan } from '../browse-tree';
import { buildNameCatalogEc, buildNameSearchEc, CONFIG_TYPES, nameSearchPlan } from '../object-search';
import { buildHoverResolveEc } from '../handlers/objects';
import { buildIdentityEc } from '../handlers/code-search';
import { buildStudioChildrenEc } from '../handlers/studio';
import { buildContextQueryEc } from '../handlers/ai-tools';
import { buildSuggestEc, buildSuggestPartEc } from '../compare-read';
import { buildRefRidsEc, groupRefExprs } from '../ref-rid';
import { buildFetchEc, buildContextEc, buildFlowRefChildrenEc, buildEditPageFetchEc, buildFlowRefListEc, buildObjectTypeListEc, buildObjectTypeSiblingsEc, type BlueprintCtx } from '../layout/sync';
import { buildInstanceFanoutEc, buildContainerBlastEc, buildFlowContainerBlastEc } from '../layout/blast-radius';
import { buildFlowSettingsEc } from '../layout/flow-settings';
import { buildPortableIdOccupancyEc } from '../layout/portable-ids';
import { buildAllowedByTypeEc, buildAllowedObjectsEc, PANE_PROPS } from '../bmp-client';
import {
  buildTransportChildrenEc, buildTransportCountEc, buildTransportRootCountEc, buildTransportCreationEc, buildTransportLogEc, buildTransportNeighboursEc, buildTransportObjectEc, buildTransportRootChildrenEc,
  buildTransportRowEc, buildTransportScanEc, buildTransportStartEc, buildTransportUnderEc, buildTransportUnderSinceEc,
  buildTransportSearchEc, buildTransportUsedByEc, TRANSPORT_SEARCH_MAX, buildTransportFactsEcs, TRANSPORT_FACTS_BATCH, buildTransportFileTextEc, buildTransportObjectNoContentEc, buildTransportSourceListingEc,
} from '../transport-read';
import { TRANSPORT_ROOTS } from '../transport-bundle';
import { compileSearch, referencePrefilter } from '../code-search-match';
import { BmpTransport } from '../bmp-transport';
import { makeExtendedExecuteCommand, registerBmpTypes } from '../bmp-types';
import { readAccess, searchAccessObjects, searchAccessPrincipals, searchListItems } from '../access-workspace/read';
import { readCreationContext } from '../access-workspace/creation';
import { readResult } from '../access-workspace/test-response';
import { framedText } from '../ec-parser';
import type { BmpClient } from '../bmp-client';
import { growingTexts } from './ec-growth';

afterEach(() => vi.unstubAllGlobals());

type Kind = 'constant' | 'varying' | 'user' | 'fallback';
interface Entry { fn: string; kind: Kind; a: () => string | string[]; b?: () => string | string[] }

const types = codeTypes(KNOWN_CODE_PROPS);
const fields = (n: number, dir: 'in' | 'out') => Array.from({ length: n }, (_, i) => ({ accessor: `ref_field_${i}`, label: '', direction: dir }));
const RID_A = '9223372036854775801', RID_B = '1234567890123456789';
const longId = 'x'.repeat(110);
const prefilter = (q: string) => { const c = compileSearch({ query: q, caseSensitive: false, wholeWord: false, regex: false }); if ('error' in c) throw new Error(c.error); return c.prefilter; };
const ctxA: BlueprintCtx = { pageId: 'page_a', pageRid: RID_A, tabsetId: 'tabset_a', target: 'instance', pageClass: 'Scorecard', hasTemplate: false, tabScope: 'all' } as BlueprintCtx;
const ctxB: BlueprintCtx = { ...ctxA, pageId: 'page_b', pageRid: RID_B, tabsetId: 'tabset_b', tabsetRid: RID_A };
const typeChunks = chunkByScriptSize(types, t => buildSourceListEc(t, KNOWN_CODE_PROPS), 20_000);

/** Scripts a fake client was asked to run (access workspace reads). */
async function accessScripts(run: (client: BmpClient) => Promise<unknown>, answer: (code: string) => string[][] = () => []): Promise<string[]> {
  const seen: string[] = [];
  const reply = (code: string) => { seen.push(code); return readResult(code, framedText(answer(code), false)); };
  const client = {
    executeEc: vi.fn(async (code: string) => reply(code)),
    executeEcOn: vi.fn(async (code: string) => reply(code)),
    executeEcEach: vi.fn(async (code: string, rids: readonly string[]) => new Map(rids.map(r => [r, reply(code)]))),
  } as unknown as BmpClient;
  await run(client).catch(() => undefined);
  return seen;
}

/** Scripts the object service sends for one object (its context reads). */
async function serviceScripts(rid: string): Promise<string[]> {
  const seen: string[] = [];
  const on = vi.fn(async (code: string) => { seen.push(code); return { ok: true, log: '' }; });
  const each = vi.fn(async (code: string, rids: readonly string[]) => { seen.push(code); return new Map(rids.map(r => [r, { ok: true, log: '' }])); });
  const svc = new EcQueryService(async () => ({ ok: true, log: '' }), async r => `lookup(${r})`, PANE_PROPS, async () => new Map(), { on, each });
  await svc.resolveTemplate(rid).catch(() => undefined);
  await svc.fetchEditorContext(rid, ['showExpression']).catch(() => undefined);
  return seen;
}

const ENTRIES: Entry[] = [
  // ── constant: the object, query or date is not in the text ──────────
  { fn: 'buildObjectPaneEc', kind: 'constant', a: () => buildObjectPaneEc(CONTEXT_OBJECT, PANE_PROPS) },
  { fn: 'buildContextRowFactsEc', kind: 'constant', a: () => [buildContextRowFactsEc(), buildContextRowFactsEc({ facts: false })] },
  { fn: 'buildContextSummaryEc', kind: 'constant', a: () => buildContextSummaryEc() },
  { fn: 'buildContextEnrichEc', kind: 'constant', a: () => buildContextEnrichEc() },
  { fn: 'buildContextCodeReadEc', kind: 'constant', a: () => buildContextCodeReadEc(['expression', 'html', 'javascript', 'afterExpression', 'showExpression', 'enableExpression']) },
  { fn: 'buildCodeReadEc', kind: 'constant', a: () => buildCodeReadEc(CONTEXT_OBJECT, ['expression', 'showExpression']) },
  { fn: 'buildLayoutTreeEc', kind: 'constant', a: () => buildLayoutTreeEc(CONTEXT_OBJECT) },
  { fn: 'buildAccessSubjectsEc', kind: 'constant', a: () => buildAccessSubjectsEc() },
  { fn: 'buildColorSetsEc', kind: 'constant', a: () => buildColorSetsEc() },
  { fn: 'buildContextReadEc', kind: 'constant', a: () => buildContextReadEc(KNOWN_CODE_PROPS.ButtonInput) },
  { fn: 'buildContextRefResolveEc', kind: 'constant', a: () => buildContextRefResolveEc() },
  { fn: 'buildInboundEc', kind: 'constant', a: () => buildInboundEc(CONTEXT_OBJECT) },
  { fn: 'buildInstancesEc', kind: 'constant', a: () => buildInstancesEc(CONTEXT_OBJECT) },
  { fn: 'buildConnectionsEc', kind: 'constant', a: () => buildConnectionsEc(CONTEXT_OBJECT, fields(10, 'in')) },
  { fn: 'buildContextJunctionEc', kind: 'constant', a: () => buildContextJunctionEc(fields(10, 'out')) },
  { fn: 'buildStructureEc', kind: 'constant', a: () => buildStructureEc(CONTEXT_OBJECT, { via: 'inputSet', depth: 4 }) },
  { fn: 'buildAncestorsEc', kind: 'constant', a: () => buildAncestorsEc(CONTEXT_OBJECT) },
  { fn: 'buildEditFieldPropertyEc', kind: 'constant', a: () => buildEditFieldPropertyEc(CONTEXT_OBJECT, ['CeRiskAssessment', 'CeIssue', 'CeControlMeasure']) },
  { fn: 'buildPropertyApplicationsEc', kind: 'constant', a: () => buildPropertyApplicationsEc(CONTEXT_OBJECT) },
  { fn: 'buildEditFieldTypesEc', kind: 'constant', a: () => buildEditFieldTypesEc(CONTEXT_OBJECT) },
  { fn: 'buildRootListEc', kind: 'constant', a: () => buildRootListEc(CODE_ROOTS.map(r => r.key), EC_FRAME) },
  { fn: 'buildCodeScopeEc', kind: 'constant', a: () => buildCodeScopeEc(CONTEXT_OBJECT, 'InputView', EC_FRAME, KNOWN_CODE_PROPS, types.slice(0, 2)) },
  { fn: 'buildCodeScopeEcs', kind: 'constant', a: () => buildCodeScopeEcs(CONTEXT_OBJECT, 'InputView', EC_FRAME, KNOWN_CODE_PROPS) },
  // The search's listing and reads: the source is the context; a root by
  // its accessor is a fixed set.
  { fn: 'buildSourceListEc', kind: 'constant', a: () => typeChunks.map(t => buildSourceListEc(t, KNOWN_CODE_PROPS)), b: () => typeChunks.map(t => buildSourceListEc(t, KNOWN_CODE_PROPS)) },
  { fn: 'buildSourceCodeEc', kind: 'constant', a: () => types.flatMap(t => [buildSourceCodeEc(t, KNOWN_CODE_PROPS), buildSourceCodeEc(t, KNOWN_CODE_PROPS, 3, 4)]) },
  { fn: 'buildNameCatalogEc', kind: 'constant', a: () => chunkByScriptSize(CONFIG_TYPES, g => buildNameCatalogEc(g), 12_000).map(g => buildNameCatalogEc(g)) },
  // Was a reference in the text: now the object found by ref-rid.
  { fn: 'buildHoverResolveEc', kind: 'constant', a: () => buildHoverResolveEc(CONTEXT_OBJECT) },
  { fn: 'buildSuggestPartEc', kind: 'constant', a: () => (['template', 'object', 'parent'] as const).map(p => buildSuggestPartEc(p)) },
  // Blueprint: the page is the context, the tabset its item.
  { fn: 'buildFetchEc', kind: 'constant',
    a: () => [buildFetchEc(ctxA, { onContext: true }), buildFetchEc({ ...ctxA, target: 'template' }, { onContext: true }), buildFetchEc({ ...ctxA, resultOnly: true }, { onContext: true }), buildFetchEc(ctxA, { projection: 'structure', chunkSize: 32, includeHeight: false, onContext: true })],
    b: () => [buildFetchEc(ctxB, { onContext: true }), buildFetchEc({ ...ctxB, target: 'template' }, { onContext: true }), buildFetchEc({ ...ctxB, resultOnly: true }, { onContext: true }), buildFetchEc(ctxB, { projection: 'structure', chunkSize: 32, includeHeight: false, onContext: true })] },
  { fn: 'buildContextEc', kind: 'constant', a: () => buildContextEc(CONTEXT_OBJECT) },
  { fn: 'buildFlowRefChildrenEc', kind: 'constant', a: () => buildFlowRefChildrenEc(CONTEXT_OBJECT) },
  { fn: 'buildEditPageFetchEc', kind: 'constant', a: () => buildEditPageFetchEc(CONTEXT_OBJECT) },
  { fn: 'buildFlowRefListEc', kind: 'constant', a: () => [buildFlowRefListEc('InputSet'), buildFlowRefListEc('EditPage')] },
  { fn: 'buildObjectTypeListEc', kind: 'constant', a: () => buildObjectTypeListEc() },
  { fn: 'buildFlowSettingsEc', kind: 'varying', a: () => buildFlowSettingsEc('9007837798074769804', 'ReferenceInput') },
  { fn: 'buildObjectTypeSiblingsEc', kind: 'varying', a: () => buildObjectTypeSiblingsEc(['1463796860208468677', '6935556136354115450']) },
  // The object is the context; the text varies only with the reference
  // definition (a small fixed set per server).
  { fn: 'buildAllowedObjectsEc', kind: 'constant', a: () => buildAllowedObjectsEc(`lookup(${RID_A})`) },
  // By type: the text varies only with the definition's allowed types (a
  // small fixed set per server); no object, no definition in it.
  { fn: 'buildAllowedByTypeEc', kind: 'constant', a: () => [buildAllowedByTypeEc(['CeProcedure'], true), buildAllowedByTypeEc(['CeProcedure', 'CeProcess', 'CeRiskAssessment'], false)] },
  // The index: an organisation or a root as the context, the day as the
  // context's end. A count names no place (a root by its accessor is the
  // fallback, a fixed set).
  { fn: 'buildCountEc', kind: 'constant', a: () => [...countGroups(types).map(g => buildCountEc(g)), ...countGroups(types).map(g => buildCountEc(g, CONTEXT_OBJECT, true)), buildCountEc(types.slice(0, 4), 'root.portal')] },
  { fn: 'buildBucketInventoryEc', kind: 'constant', a: () => [buildBucketInventoryEc(orgBucket('100'), types.slice(0, 20), EC_FRAME, { since: '2026-11-01' }, true), buildBucketInventoryEc(orgBucket('100', true), types.slice(0, 20), EC_FRAME, {}, true), buildBucketInventoryEc(rootBucket('portal'), types.slice(0, 20), EC_FRAME, { since: '2026-11-01' }, true)],
    b: () => [buildBucketInventoryEc(orgBucket('200'), types.slice(0, 20), EC_FRAME, { since: '2026-11-09' }, true), buildBucketInventoryEc(orgBucket('200', true), types.slice(0, 20), EC_FRAME, {}, true), buildBucketInventoryEc(rootBucket('portal'), types.slice(0, 20), EC_FRAME, { since: '2026-11-09' }, true)] },
  { fn: 'buildSummaryEc', kind: 'constant', a: () => buildSummaryEc(types.slice(0, 10), ['root', 'root.portal'], '2026-11-01', EC_FRAME, true), b: () => buildSummaryEc(types.slice(0, 10), ['root', 'root.portal'], '2026-11-09', EC_FRAME, true) },
  { fn: 'buildExistsEc', kind: 'constant', a: () => buildExistsEc(types.slice(0, 16), ['root', 'root.portal']) },
  { fn: 'buildSampleEc', kind: 'constant', a: () => buildSampleEc(types.slice(0, 16)) },
  // Transport (beta): the object is the command's context.
  { fn: 'buildTransportObjectEc', kind: 'constant', a: () => buildTransportObjectEc() },
  { fn: 'buildTransportCreationEc', kind: 'constant', a: () => buildTransportCreationEc() },
  // A file's whole text and creation text, read only within the limit.
  { fn: 'buildTransportFileTextEc', kind: 'constant', a: () => buildTransportFileTextEc() },
  { fn: 'buildTransportObjectNoContentEc', kind: 'constant', a: () => buildTransportObjectNoContentEc() },
  { fn: 'buildTransportNeighboursEc', kind: 'constant', a: () => buildTransportNeighboursEc() },
  // The transport log: a fixed folder ID.
  { fn: 'buildTransportLogEc', kind: 'constant', a: () => buildTransportLogEc() },
  // Everything under the context object, without a day.
  { fn: 'buildTransportUnderEc', kind: 'constant', a: () => buildTransportUnderEc() },
  // The context object's own row, and its children's RIDs.
  { fn: 'buildTransportRowEc', kind: 'constant', a: () => buildTransportRowEc() },
  { fn: 'buildTransportChildrenEc', kind: 'constant', a: () => buildTransportChildrenEc() },
  // What uses one object: the object is the context.
  { fn: 'buildTransportUsedByEc', kind: 'constant', a: () => buildTransportUsedByEc() },
  { fn: 'buildTransportCountEc', kind: 'constant', a: () => buildTransportCountEc() },
  // ── varying: the question is in the text, small ─────────────────────
  { fn: 'buildRefRidsEc', kind: 'varying', a: () => groupRefExprs(Array.from({ length: 80 }, (_, i) => `ceras.get("${longId}${i}")`)).map(g => buildRefRidsEc(g!)) },
  { fn: 'buildIdentityEc', kind: 'varying', a: () => buildIdentityEc(`ceras.${longId}`) },
  { fn: 'idLookupPlan', kind: 'varying', a: () => { const p = idLookupPlan(`ceras.${longId}`); return groupRefExprs(p.exprs, p.prelude).map(g => buildRefRidsEc(g!, p.prelude)); } },
  { fn: 'buildHitScanEcs', kind: 'varying', a: () => [
    ...buildHitScanEcs(types, prefilter('y'.repeat(2_000)), KNOWN_CODE_PROPS),
    ...buildHitScanEcs(types, referencePrefilter({ rid: RID_A, businessId: longId }), KNOWN_CODE_PROPS, true),
  ].map(s => s.code) },
  { fn: 'buildNameSearchEc', kind: 'varying', a: () => CONFIG_TYPES.map(t => buildNameSearchEc(t, 'q'.repeat(200))) },
  { fn: 'buildStudioChildrenEc', kind: 'varying', a: () => buildStudioChildrenEc(longId) },
  // Transport (beta) scan: the root (an allow-list) and the day are in the text.
  { fn: 'buildTransportScanEc', kind: 'varying', a: () => TRANSPORT_ROOTS.map(r => buildTransportScanEc(r, '2026-11-15')) },
  // Under an object: the ID (at most 128 characters) to find it, and the day.
  { fn: 'buildTransportStartEc', kind: 'varying', a: () => [buildTransportStartEc('a'), buildTransportStartEc(`_${'x'.repeat(127)}`, 'k')] },
  // The children of one root (an allow-list).
  { fn: 'buildTransportRootChildrenEc', kind: 'varying', a: () => TRANSPORT_ROOTS.map(r => buildTransportRootChildrenEc(r)) },
  { fn: 'buildTransportRootCountEc', kind: 'varying', a: () => TRANSPORT_ROOTS.map(r => buildTransportRootCountEc(r)) },
  { fn: 'buildTransportUnderSinceEc', kind: 'varying', a: () => buildTransportUnderSinceEc('2026-11-15') },
  // What this workspace has under a listing start: the longest ID.
  { fn: 'buildTransportSourceListingEc', kind: 'varying', a: () => buildTransportSourceListingEc(`t._${'x'.repeat(127)}`) },
  // The facts of used objects: the addresses are in the text; a batch of the longest IDs.
  { fn: 'buildTransportFactsEcs', kind: 'varying', a: () => buildTransportFactsEcs(Array.from({ length: TRANSPORT_FACTS_BATCH }, (_, i) => `t.${'x'.repeat(125)}${String(i).padStart(2, '0')}`)) },
  // The search: the root and the text are in the text; the longest text, every character escaped.
  { fn: 'buildTransportSearchEc', kind: 'varying', a: () => TRANSPORT_ROOTS.flatMap(r => [buildTransportSearchEc(r, 'q'.repeat(TRANSPORT_SEARCH_MAX)), buildTransportSearchEc(r, '"\\'.repeat(TRANSPORT_SEARCH_MAX / 2))]) },
  // ── user: a write, or a read inside the user's own write ───────────
  { fn: 'buildInstanceFanoutEc', kind: 'user', a: () => buildInstanceFanoutEc(`t.${longId}`) },
  { fn: 'buildContainerBlastEc', kind: 'user', a: () => buildContainerBlastEc(Array.from({ length: 40 }, (_, i) => `t.c_${i}`)) },
  { fn: 'buildFlowContainerBlastEc', kind: 'user', a: () => buildFlowContainerBlastEc(Array.from({ length: 20 }, (_, i) => ({ id: `ref_${i}`, className: 'InputSet' as const, ref: `t.ref_${i}` }))) },
  { fn: 'buildPortableIdOccupancyEc', kind: 'user', a: () => buildPortableIdOccupancyEc(Array.from({ length: 40 }, (_, i) => `portable_id_${i}`)) },
  { fn: 'buildContextQueryEc', kind: 'user', a: () => userScript(buildContextQueryEc(CONTEXT_OBJECT, 'ActionButton', undefined, ['name', 'id', 'showExpression'])) },
  // ── fallback: the object in the text, for a client without the context path
  { fn: 'buildRowFactsEc', kind: 'fallback', a: () => buildRowFactsEc([{ rid: RID_A, ref: `lookup(${RID_A})` }]) },
  { fn: 'buildSummariesEc', kind: 'fallback', a: () => buildSummariesEc([{ rid: RID_A, ref: `lookup(${RID_A})` }]) },
  { fn: 'buildBatchEnrichEc', kind: 'fallback', a: () => buildBatchEnrichEc([`lookup(${RID_A})`]) },
  { fn: 'buildBatchCodeReadEc', kind: 'fallback', a: () => buildBatchCodeReadEc([`lookup(${RID_A})`], ['expression']) },
  { fn: 'buildJunctionEc', kind: 'fallback', a: () => buildJunctionEc([RID_A], fields(3, 'out')) },
  { fn: 'buildStructureEcMany', kind: 'fallback', a: () => buildStructureEcMany([{ ref: `lookup(${RID_A})`, rule: { depth: 2 } }]) },
  { fn: 'buildReadEc', kind: 'fallback', a: () => buildReadEc([{ rid: RID_A, ref: `lookup(${RID_A})`, type: 'ButtonInput', props: KNOWN_CODE_PROPS.ButtonInput }]) },
  { fn: 'buildRefResolveEc', kind: 'fallback', a: () => buildRefResolveEc(['t.a', 'o.b']) },
  { fn: 'buildSuggestEc', kind: 'fallback', a: () => buildSuggestEc(`lookup(${RID_A})`, { templateRef: `lookup(${RID_B})` }) },
];

/**
 * Loops that append to one text per element and are not cut in the script, with what bounds
 * them. Everything else a builder loops over is cut (`.first(n)`, a counter), joined
 * (`calculate` + `join("")`) or collected in the short chunk of ec-parser. A loop over objects
 * of a type, over everything under a root or over the instances of a template does not belong
 * here: those lists have no bound.
 */
const BOUNDED_LOOPS: Record<string, Record<string, string>> = {
  buildObjectPaneEc: {
    '_o.parent.rref(editPage).forEach(_view:': 'the forms that use one edit page',
    '_o.parent.types.forEach(_type:': 'the types of one edit page',
    '_o.addableItems.forEach(_i:': 'the item types one object can add',
  },
  buildColorSetsEc: { '_colors.forEach(_col:': 'the colours of the portal\'s colour sets; one parenthesised row each' },
  buildConnectionsEc: { '_o.ref_field_N.forEach(_t:': 'the values of one reference property of one object' },
  buildEditFieldPropertyEc: { 'c.get(T.name).children().forEach(_app:': 'the properties of one class' },
  buildEditFieldTypesEc: {
    '_o.parent.rref(editPage).forEach(_view:': 'the forms that use one edit page',
    '_o.parent.types.forEach(_type:': 'the types of one edit page',
  },
  buildCodeScopeEc: { '_lb.forEach(_b:': 'a row per followed object, started again for each' },
  buildCodeScopeEcs: { '_lb.forEach(_b:': 'a row per followed object, started again for each' },
  buildFetchEc: {
    '_tabsets.forEach(_ts:': 'the tab sets of one page',
    '_ts.descendants().forEach(_n:': 'the layout of one tab set',
    '_w.actionObject.children().forEach(_tr:': 'the children of one action object',
    '_layoutNodes.forEach(_w:': 'the layout nodes of one page',
    '_fref.children().forEach(_fc:': 'the fields of one form',
  },
  buildFlowRefChildrenEc: { '_ref.children().forEach(_fc:': 'the fields of one form' },
  buildEditPageFetchEc: {
    '_ref.types.forEach(_type:': 'the types of one edit page',
    '_ref.children().forEach(_fc:': 'the fields of one form',
  },
  buildTransportCreationEc: { '_o.rref(linkedTo).forEach(_i:': 'the class links of one property definition (asked only for a MethodConfig)' },
  buildStudioChildrenEc: { '_c.children().forEach(_ch:': 'the children of one object' },
  buildPortableIdOccupancyEc: { '_ids.forEach(_id:': 'the IDs written into the script' },
  buildContextQueryEc: { '_items.as(className).distinct().forEach(_class:': 'the distinct class names of the result' },
};

/** Exported names in src/lib that are not script builders. */
const NOT_SCRIPTS = new Set(['buildRowEc', 'buildInventoryEc' /* tests only */]);

const flat = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

describe('script kinds', () => {
  it('no builder appends to one text per element of an uncut loop, except the loops listed with their bound', () => {
    // Rows collected in the short chunk of ec-parser (appendRowEc into EC_CHUNK, flushed every few rows) are not listed.
    const chunked = (g: { variable: string; line: string }) => g.variable === EC_CHUNK || g.variable === '_chunk' || /:= _r \+ (_rc|_chunk)$/.test(g.line);
    const loopOf = (open: string) => open.replace(/ref_field_\d+/g, 'ref_field_N').replace(/_[cf]\d+\./g, '_N.').replace(/c\.get\(Ce\w+/g, 'c.get(T').replace(/lookup\(\d+\)/g, 'lookup(N)');
    const found: Record<string, string[]> = {};
    for (const e of ENTRIES) {
      const loops = new Set([...flat(e.a()), ...(e.b ? flat(e.b()) : [])].flatMap(s => growingTexts(s)).filter(g => !chunked(g)).map(g => loopOf(g.loop)));
      if (loops.size) found[e.fn] = [...loops].sort();
    }
    const listed = Object.fromEntries(Object.entries(BOUNDED_LOOPS).map(([fn, loops]) => [fn, Object.keys(loops).sort()]));
    expect(found, 'A new loop that grows a text: cut it (.first(n) or a counter), build the rows with calculate( … ) and join(""), or list it in BOUNDED_LOOPS with what bounds it.').toEqual(listed);
  });

  it('every exported script builder in src/lib is listed', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== '__tests__') walk(p); continue; }
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        for (const m of readFileSync(p, 'utf8').matchAll(/export function (build\w*Ecs?)\b/g)) names.add(m[1]);
      }
    };
    walk(root);
    const listed = new Set(ENTRIES.map(e => e.fn));
    expect([...names].filter(n => !listed.has(n) && !NOT_SCRIPTS.has(n)).sort()).toEqual([]);
  });

  it('constant builders give one text for different inputs, marked constant, within 25,000', () => {
    for (const e of ENTRIES.filter(x => x.kind === 'constant')) {
      const a = flat(e.a()), b = flat((e.b ?? e.a)());
      expect(b, e.fn).toEqual(a);
      for (const s of a) {
        expect(s.length, e.fn).toBeLessThanOrEqual(SCRIPT_LIMITS.constant);
        expect(classifyScript(s).kind, `${e.fn}: ${s.slice(0, 60)}`).toBe('constant');
      }
    }
  });

  it('the object service and the Access workspace send the same constant text for other objects and RIDs', async () => {
    expect(await serviceScripts(RID_B)).toEqual(await serviceScripts(RID_A));
    for (const s of await serviceScripts(RID_A)) expect(classifyScript(s).kind).toBe('constant');
    // An inventory of other records, the same sizes: the same page scripts.
    const inventory = (base: bigint) => (code: string) => code.includes('rolesIds')
      ? [['roots', '1', '2'], ['rolesIds', Array.from({ length: 300 }, (_, i) => String(base + BigInt(i))).join(',')], ['policiesIds', ''], ['principalsIds', '']]
      : [];
    const pagesA = await accessScripts(c => readAccess(c, 'e', 'n'), inventory(9000000000000000000n));
    const pagesB = await accessScripts(c => readAccess(c, 'e', 'n'), inventory(8000000000000000000n));
    expect(pagesA.length).toBeGreaterThan(1);
    expect(pagesB).toEqual(pagesA);
    for (const s of pagesA) { expect(classifyScript(s).kind).toBe('constant'); expect(s).not.toMatch(/9000000000000000\d{3}/); }
    const creation = async (rid: string) => accessScripts(c => readCreationContext(c, 'CeRiskAssessment', rid, []));
    expect(await creation(RID_B)).toEqual(await creation(RID_A));
  });

  it('varying builders stay within 1,200 characters at their largest input', async () => {
    for (const e of ENTRIES.filter(x => x.kind === 'varying')) {
      for (const s of flat(e.a())) {
        expect(s.length, e.fn).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
        expect(classifyScript(s).kind, e.fn).toBe('varying');
      }
    }
    const q = 'w'.repeat(200);
    const scripts = [
      ...await accessScripts(c => searchAccessObjects(c, q, 'CeRiskAssessment', false, undefined, true, 'CeRiskAssessment'), code => code.includes('access roots') || code.includes('root.organisation.rid') ? [['ceRiskAssessment', RID_A]] : []),
      ...await accessScripts(c => searchAccessObjects(c, `${q.slice(0, 190)}*`), code => code.includes('root.organisation.rid') ? [['organisation', RID_A], ['ceIssue', RID_B]] : []),
      ...await accessScripts(c => searchAccessPrincipals(c, q, 'User')),
      ...await accessScripts(c => searchListItems(c, RID_A, q, undefined, Array.from({ length: 100 }, (_, i) => `ListPropertySetItem:item_${i}_${'z'.repeat(40)}`))),
    ];
    const varying = scripts.filter(s => classifyScript(s).kind === 'varying');
    expect(varying.length).toBeGreaterThan(4);
    for (const s of varying) expect(s.length, s.slice(0, 80)).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    for (const s of scripts) expect(s, 'no RID of the records in the text').not.toContain(`lookup(${RID_A})`);
  });

  it('user builders are the user\'s, within 25,000', () => {
    for (const e of ENTRIES.filter(x => x.kind === 'user')) {
      for (const s of flat(e.a())) {
        expect(s.length, e.fn).toBeLessThanOrEqual(SCRIPT_LIMITS.user);
        expect(classifyScript(s).kind, e.fn).toBe('user');
      }
    }
    expect(classifyScript('_x := 1', true).kind).toBe('user');
  });

  it('fallback builders count as varying, so a long one can never reach a server', () => {
    for (const e of ENTRIES.filter(x => x.kind === 'fallback')) for (const s of flat(e.a())) expect(classifyScript(s).kind, e.fn).toBe('varying');
    // The text versions of the context builders are varying too.
    for (const s of [buildFetchEc(ctxA), buildContextEc(RID_A), buildFlowRefChildrenEc('ref'), buildEditPageFetchEc('ref'), buildHoverResolveEc('t.x'),
      buildCountEc(['ButtonInput'], 'lookup(100)'), buildSummaryEc(types.slice(0, 2), ['root'], '2026-11-01', EC_FRAME)]) {
      expect(classifyScript(s).kind).toBe('varying');
    }
  });

  it('the search\'s listing and reads never write a source into the text', () => {
    expect(() => buildSourceListEc(types.slice(0, 4), KNOWN_CODE_PROPS, `lookup(${RID_A})`)).toThrow(/Invalid source/);
    expect(() => buildSourceCodeEc('ButtonInput', KNOWN_CODE_PROPS, 0, 1, `lookup(${RID_A})`)).toThrow(/Invalid source/);
  });

  it('split scripts stay near their target size (one type alone may go a little over)', () => {
    const near = (texts: readonly string[], target: number, what: string) => {
      expect(texts.length, what).toBeGreaterThan(1);
      for (const s of texts) expect(s.length, what).toBeLessThanOrEqual(target * 1.5);
    };
    near(buildCodeScopeEcs(CONTEXT_OBJECT, 'InputSet', EC_FRAME, KNOWN_CODE_PROPS), SCRIPT_TARGET_CHARS, 'code scope');
    near(chunkByScriptSize(types, t => buildSummaryEc(t, ['root', 'root.portal'], '2026-11-01', EC_FRAME, true)).map(t => buildSummaryEc(t, ['root', 'root.portal'], '2026-11-01', EC_FRAME, true)), SCRIPT_TARGET_CHARS, 'index summary');
    near(countGroups(types).map(g => buildCountEc(g, CONTEXT_OBJECT, true)), SCRIPT_TARGET_CHARS, 'index count');
    near(chunkByScriptSize(types, t => buildBucketInventoryEc(rootBucket('portal'), t, EC_FRAME, { since: '2026-11-01' }, true)).map(t => buildBucketInventoryEc(rootBucket('portal'), t, EC_FRAME, { since: '2026-11-01' }, true)), SCRIPT_TARGET_CHARS, 'index list');
    near(typeChunks.map(t => buildSourceListEc(t, KNOWN_CODE_PROPS)), 20_000, 'search listing');
    near(chunkByScriptSize(CONFIG_TYPES, g => buildNameCatalogEc(g), 12_000).map(g => buildNameCatalogEc(g)), 12_000, 'name catalog');
  });

  it('a name query of quotes and backslashes never makes a refused script: a type that does not fit is not searched', () => {
    for (const q of ['"\\'.repeat(100), '\\'.repeat(200), '"'.repeat(200), 'q'.repeat(200)]) {
      const plan = nameSearchPlan(CONFIG_TYPES, q);
      expect(plan.send.length + plan.notSearched.length).toBe(CONFIG_TYPES.length);
      for (const s of plan.send) expect(s.code.length).toBeLessThanOrEqual(SCRIPT_LIMITS.varying);
    }
    // Far over the limit after escaping: not searched, never sent.
    expect(nameSearchPlan(['TextInput'], '"'.repeat(400))).toEqual({ send: [], notSearched: ['TextInput'] });
  });

  it('a constant builder that makes too many texts stops counting as constant', () => {
    resetScriptKinds();
    for (let i = 0; i < 200; i++) constantScript('runaway', `"${i}"`);
    expect(classifyScript('"5"').kind).toBe('constant');
    expect(classifyScript('"199"').kind).toBe('varying');
    resetScriptKinds();
  });
});

describe('the transport refuses a script over its kind\'s limit', () => {
  const transport = () => {
    registerBmpTypes();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const auth = { sessionEpoch: 0, getLoginTicket: vi.fn().mockResolvedValue('t'), refreshLoginTicket: vi.fn(), rejectCommandAuthentication: vi.fn(), fetchCommand: vi.fn() };
    return { t: new BmpTransport('https://bmp.size.test/', auth as never), auth, fetch };
  };

  it('a varying script over 1,200 characters, unmarked or marked, is not sent', async () => {
    const { t, auth, fetch } = transport();
    await expect(t.sendStreamingCommand(makeExtendedExecuteCommand('1 + '.repeat(400)), 'read'))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/unmarked script.*1600 characters.*limit of 1200/) });
    await expect(t.sendStreamingCommand(makeExtendedExecuteCommand(varyingScript('demo', '2 + '.repeat(400))), 'read'))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/demo \(varying\)/) });
    expect(auth.fetchCommand).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a constant or user script over 25,000 characters is not sent', async () => {
    const { t, auth, fetch } = transport();
    await expect(t.sendStreamingCommand(makeExtendedExecuteCommand(constantScript('big', '3 + '.repeat(7_000))), 'read'))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/big \(constant\).*limit of 25000/) });
    await expect(t.sendStreamingCommand(makeExtendedExecuteCommand(userScript('4 + '.repeat(7_000))), 'read'))
      .rejects.toMatchObject({ kind: 'protocol', message: expect.stringMatching(/user script.*limit of 25000/) });
    expect(auth.fetchCommand).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
