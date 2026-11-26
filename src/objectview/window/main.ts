/**
 * Object window entry (objectview/window.html) — the only module of the new
 * window that touches chrome.*. It builds the runtime data source (reads and
 * the existing write routes), wires the frame protocol (ready, activate,
 * close with the dirty guard, Escape) and hands everything else to the
 * controller and the view.
 */

import { escapeLayers } from '../../lib/escape-layers';
import { isTypingIn, whichShortcut } from '../../lib/shortcuts';
import { installCheatSheetKey } from '../../lib/cheat-sheet';
import { copyText } from '../../lib/copy-feedback';
import type { InspectorMessage, ObjectWindowFrameActivation, ObjectWindowOrigin } from '../../lib/types';
import { sendFireForget, sendRequest, sendRequestBounded } from '../../lib/messaging';
import { installDirtyGuards } from '../../editor-core/overlay';
import { discardTitle, DISCARD_LABEL, KEEP_EDITING_LABEL } from '../../lib/unsaved';
import { choiceModal, confirmCommandModal, confirmModal } from '../../lib/modal';
import { intersectTypeSchemas } from '../../lib/type-schema-utils';
import { accessDestinationForObject } from '../../lib/access-workspace/entry';
import { hasStudio } from '../../lib/studio-mode';
import { openColorPicker } from '../../lib/color-picker';
import { WorkspaceColorCatalogue } from '../../lib/workspace-color-catalogue';
import { createImageEditor, ImageCatalogue } from '../../lib/image-picker';
import { ThumbCache } from '../../lib/colors-images/thumb-cache';
import { ObjectWindowView, type InboundTarget, type PropertyChoices, type WindowHint } from './view';
import type { FullObject } from '../../lib/object-read';
import { templateRidOf } from './draft';
import { usedInCode } from '../../lib/used-in-code';
import { ObjectWindowController, type ObjectWindowSource } from './controller';
import { customRequestFailure, LOST_RESPONSE, type SaveOutcome, type SaveStep } from './save-plan';
import type { ObjectLabel } from '../../lib/messages';
import { AccessMode, type AccessPrefs, type AccessSource } from './access-state';
import type { AccessSubject } from '../../lib/types';
import { codeIndexStore } from '../../lib/code-index-store';
import { setIndexedCodeProps } from '../../lib/object-window-table';
import { watchWindowEnvironment } from '../../lib/window-environment';
import { fromParent, postTitleToParent, postToParent } from '../../lib/frame-parent';

const OPEN_TIMEOUT_MS = 30_000;
/** "Used by": a whole-workspace rref() scan; it can take minutes on a much-used object. */
const INBOUND_TIMEOUT_MS = 300_000;
/** The node selection reports the current position after this pause, so
 *  arrow keys through the tree send one message, not one per row. */
const POSITION_DELAY_MS = 400;
const ENRICH_TIMEOUT_MS = 20_000;
const SAVE_TIMEOUT_MS = 60_000;
/** SAVE_IDENTITY names fields as the identity does; the draft as the read does. */
const DRAFT_PROP: Record<string, string> = { businessId: 'id', name: 'name' };
/** One decision chunk or trace; the transport itself gives up after 10 s. */
const ACCESS_TIMEOUT_MS = 30_000;
const NO_ANSWER = 'No response from the extension service worker.';

type Msg<T extends InspectorMessage['type']> = Extract<InspectorMessage, { type: T }>;

/** Server of the data this window shows, pinned by the first root it read.
 *  Every read and write names it: a later read never re-stamps it, so a draft
 *  can only be written to the server it was read from; the worker refuses a
 *  read or write for another server. */
let environment: string | undefined;
const environmentWatch = watchWindowEnvironment(() => environment);

async function runStep(step: SaveStep, label?: ObjectLabel): Promise<SaveOutcome> {
  if (environmentWatch.blocked()) {
    return { ok: false, notSent: true, error: 'This window’s page now belongs to another server. Nothing was saved. Reload the window to continue.' };
  }
  const env = { ...(environment ? { environment } : {}), ...(label ? { objectLabel: label } : {}) };
  const bounded = { timeoutMs: SAVE_TIMEOUT_MS };
  // No answer within the bound: the write may have been applied (unknown).
  const lost: SaveOutcome = { ok: false, error: LOST_RESPONSE, unknown: true };
  if (step.route === 'APPLY_OBJECT_CHANGES') {
    const res = await sendRequestBounded<Msg<'APPLY_CHANGES_RESULT'>>(
      { type: 'APPLY_OBJECT_CHANGES', ...env, rid: step.rid, target: 'instance', changes: step.changes, resetProps: step.resetProps }, bounded);
    return res?.type === 'APPLY_CHANGES_RESULT' ? { ok: res.ok, error: res.error, ...(res.outcomeUnknown ? { unknown: true } : {}) } : lost;
  }
  if (step.route === 'APPLY_CUSTOM_CHANGES') {
    if (!environment) return { ok: false, notSent: true, error: 'The window does not know its server yet. Nothing was saved.' };
    let res: Msg<'APPLY_CUSTOM_CHANGES_RESULT'>;
    try {
      res = await sendRequestBounded<Msg<'APPLY_CUSTOM_CHANGES_RESULT'>>(
        { type: 'APPLY_CUSTOM_CHANGES', environment, ...(label ? { objectLabel: label } : {}), rid: step.rid, changes: step.changes, ...(step.expect ? { expect: step.expect } : {}) }, bounded);
    } catch (e) {
      // A refusal before anything was sent says so; only a lost answer "may have saved".
      return customRequestFailure(e, step.changes);
    }
    if (res?.type !== 'APPLY_CUSTOM_CHANGES_RESULT') return lost;
    // A refusal names the property (or the whole post, definition '').
    const propErrors: Record<string, string> = {};
    for (const r of res.refused ?? []) {
      for (const c of step.changes) if (!r.definition || r.definition === c.definition) propErrors[c.definition] ??= r.reason;
    }
    return {
      ok: res.ok, error: res.error, notSent: res.notSent,
      ...(res.outcomeUnknown ? { unknown: true } : {}),
      ...(Object.keys(propErrors).length ? { propErrors } : {}),
      // Changed in BMP since opened (the worker's check): nothing was written.
      ...(res.conflict?.length ? { conflict: res.conflict, ...(res.object ? { object: res.object } : {}) } : {}),
    };
  }
  if (step.route === 'SAVE_PROPERTY') {
    const res = await sendRequestBounded<Msg<'SAVE_RESULT'>>(
      {
        type: 'SAVE_PROPERTY', ...env, rid: step.rid, objectType: step.objectType, property: step.property, value: step.value,
        ...(step.valueKind ? { valueKind: step.valueKind } : {}),
      }, bounded);
    return res?.type === 'SAVE_RESULT'
      ? { ok: res.ok, error: res.error, notSent: res.notSent, ...(res.outcomeUnknown ? { unknown: true } : {}) }
      : lost;
  }
  const res = await sendRequestBounded<Msg<'SAVE_IDENTITY_RESULT'>>(
    {
      type: 'SAVE_IDENTITY', ...env, rid: step.rid,
      ...(step.businessId !== undefined ? { businessId: step.businessId } : {}),
      ...(step.name !== undefined ? { name: step.name } : {}),
      ...(step.expect ? { expect: step.expect } : {}),
    }, bounded);
  if (res?.type !== 'SAVE_IDENTITY_RESULT') return lost;
  return {
    ok: res.ok, error: res.error, notSent: res.notSent,
    ...(res.conflict?.length ? { conflict: res.conflict.map(c => ({ ...c, prop: DRAFT_PROP[c.prop] ?? c.prop })) } : {}),
  };
}

/** EditField propertyMapping choices: the class(es) of the owning
 *  CreateObjectView(s), then their shared properties. */
async function propertyChoices(rid: string): Promise<PropertyChoices> {
  // Only the owning classes, not the whole pane read.
  const res0 = await sendRequestBounded<Msg<'EDIT_FIELD_TYPES_RESULT'>>({ type: 'FETCH_EDIT_FIELD_TYPES', rid }, { timeoutMs: ENRICH_TIMEOUT_MS });
  const classes = res0?.type === 'EDIT_FIELD_TYPES_RESULT' && res0.ok ? res0.classNames : [];
  if (!classes.length) return { error: 'No owning CreateObjectView type found' };
  const res = await sendRequestBounded<Msg<'FETCH_TYPE_SCHEMAS_RESULT'>>(
    { type: 'FETCH_TYPE_SCHEMAS', classNames: classes }, { timeoutMs: Math.max(15_000, classes.length * 10_000) });
  const schemas = res?.type === 'FETCH_TYPE_SCHEMAS_RESULT' ? res.results.flatMap(r => (r.ok && r.props ? [r.props] : [])) : [];
  if (schemas.length !== classes.length) return { source: classes.join(' + '), error: 'Could not load the object property schema' };
  const shared = intersectTypeSchemas(schemas);
  shared.sort((a, b) => Number(a.systemobject) - Number(b.systemobject) || (a.label || a.accessor).localeCompare(b.label || b.accessor));
  return {
    source: classes.join(' + '),
    options: shared.map(p => ({ value: p.accessor, label: p.label && p.label !== p.accessor ? `${p.label} — ${p.accessor}` : p.accessor })),
    ...(shared.length ? {} : { error: 'No shared properties found' }),
  };
}

/** The code index's code properties per type (kept locally in IndexedDB by
 *  the code search; no server request). Code blocks and "Calls" then cover
 *  the same properties as the search. No index: the table alone decides. */
async function loadIndexedCodeProps(env: string): Promise<void> {
  try {
    const meta = await Promise.race([
      codeIndexStore().getMeta(env),
      new Promise<null>(resolve => window.setTimeout(() => resolve(null), 500)),
    ]);
    setIndexedCodeProps(meta?.codeProps ?? null);
  } catch {
    setIndexedCodeProps(null);
  }
}

const source: ObjectWindowSource = {
  async openRoot(rid, typeHint) {
    const res = await sendRequestBounded<Msg<'OBJECT_ROOT_DATA'>>(
      { type: 'OPEN_OBJECT_ROOT', rid, ...(typeHint ? { typeHint } : {}), ...(environment ? { environment } : {}) },
      { timeoutMs: OPEN_TIMEOUT_MS },
    );
    if (res?.type === 'OBJECT_ROOT_DATA' && res.environmentChanged) void environmentWatch.check();
    if (res?.type !== 'OBJECT_ROOT_DATA' || !res.ok || !res.payload) {
      throw new Error(res && 'error' in res && res.error ? res.error : 'No response from the extension service worker');
    }
    if (!environment) {
      environment = res.environment;
      accessMode.setEnvironment(res.environment);
      void environmentWatch.check();
    }
    await loadIndexedCodeProps(environment);
    return res.payload;
  },
  async readSummaries(rids) {
    const res = await sendRequestBounded<Msg<'OBJECT_SUMMARIES_DATA'>>({ type: 'READ_OBJECT_SUMMARIES', rids }, { timeoutMs: ENRICH_TIMEOUT_MS });
    if (res?.type !== 'OBJECT_SUMMARIES_DATA' || !res.ok) throw new Error(res?.error ?? 'No response');
    return { summaries: res.summaries, missing: res.missing ?? [], failed: res.failed ?? {} };
  },
  // Existing route: the type schema, falling back to help(lookup(rid))
  // (parseReferenceHelp) when the class enumeration returns nothing.
  async fieldList(type, rid) {
    const res = await sendRequestBounded<Msg<'FETCH_TYPE_SCHEMA_RESULT'>>(
      { type: 'FETCH_TYPE_SCHEMA', className: type, exampleRef: `lookup(${rid})` },
      { timeoutMs: ENRICH_TIMEOUT_MS },
    );
    if (res?.type !== 'FETCH_TYPE_SCHEMA_RESULT' || !res.ok || !res.props) throw new Error(res?.error ?? 'No response');
    return res.props;
  },
  // Field description, definition classes and list items of a type: one
  // request, cached by the service worker per profile for the connection.
  async propertySchema(type) {
    if (!environment) throw new Error('The window does not know its server yet');
    const res = await sendRequestBounded<Msg<'PROPERTY_SCHEMA_RESULT'>>(
      { type: 'FETCH_PROPERTY_SCHEMA', className: type, environment }, { timeoutMs: OPEN_TIMEOUT_MS });
    if (res?.type !== 'PROPERTY_SCHEMA_RESULT' || !res.ok || !res.schema) throw new Error(res?.type === 'PROPERTY_SCHEMA_RESULT' && res.error ? res.error : NO_ANSWER);
    return res.schema;
  },
  // The objects a reference property allows for one object: read by the
  // service worker each time (the window keeps them for its rows).
  async allowedObjects(rid, definition, type) {
    if (!environment) throw new Error('The window does not know its server yet');
    const res = await sendRequestBounded<Msg<'ALLOWED_OBJECTS_RESULT'>>(
      { type: 'FETCH_ALLOWED_OBJECTS', rid, definition, className: type, environment }, { timeoutMs: OPEN_TIMEOUT_MS });
    if (res?.type !== 'ALLOWED_OBJECTS_RESULT' || !res.ok || !res.items) throw new Error(res?.type === 'ALLOWED_OBJECTS_RESULT' && res.error ? res.error : NO_ANSWER);
    return { items: res.items, ...(res.tooMany ? { tooMany: true } : {}) };
  },
  async readObjects(rids) {
    const res = await sendRequestBounded<Msg<'FULL_OBJECTS_DATA'>>({ type: 'READ_FULL_OBJECTS', rids, ...(environment ? { environment } : {}) }, { timeoutMs: OPEN_TIMEOUT_MS });
    if (res?.type !== 'FULL_OBJECTS_DATA' || !res.ok) throw new Error(res?.error ?? 'No response');
    return { objects: res.objects, errors: res.errors };
  },
  run: runStep,
  recordChanges(changes) { sendFireForget({ type: 'RECORD_CHANGES', changes, ...(environment ? { environment } : {}) }); },
  propertyChoices,
  // The side panel's reference scan (FETCH_INBOUND): declared reverse
  // references keep their field label, every other referrer follows.
  async inbound(rid, type) {
    const res = await sendRequestBounded<Msg<'INBOUND_RESULT'>>({ type: 'FETCH_INBOUND', rid, className: type }, { timeoutMs: INBOUND_TIMEOUT_MS });
    if (res?.type !== 'INBOUND_RESULT' || !res.ok) throw new Error(res?.type === 'INBOUND_RESULT' && res.error ? res.error : NO_ANSWER);
    const seen = new Set<string>();
    const targets: InboundTarget[] = [];
    const add = (t: { rid: string; name: string; type: string; businessId: string; broken?: boolean }, field?: string) => {
      if (!t.rid || t.broken || t.rid === rid || seen.has(t.rid)) return;
      seen.add(t.rid);
      targets.push({ rid: t.rid, name: t.name, type: t.type, businessId: t.businessId, ...(field ? { field } : {}) });
    };
    for (const g of res.groups ?? []) if (g.direction === 'in') for (const t of g.targets) add(t, g.label);
    for (const t of res.targets ?? []) add(t);
    const linked = res.instances;
    const instances = linked && { total: linked.total, targets: linked.targets.map(t => ({ rid: t.rid, name: t.name, type: t.type, businessId: t.businessId })) };
    return { targets, ...(res.total != null ? { total: Math.max(res.total, targets.length) } : {}), ...(res.capped ? { capped: true } : {}), ...(instances ? { instances } : {}) };
  },
  cancelInbound(rid) { sendFireForget({ type: 'FETCH_INBOUND_CANCEL', rid }); },
  // "Used by" › "In code": the local code index, as the search window's "Used in code".
  async usedInCode(obj) {
    const res = await usedInCode(obj);
    return {
      targets: res.hits && res.hits.filter(h => h.rid !== obj.rid).map(h => ({ rid: h.rid, name: h.name, type: h.type, businessId: h.businessId, places: h.matches })),
      coverage: res.coverage,
    };
  },
  // One batched read-only post per request (lib/code-ref-resolve.ts).
  async resolveRefs(keys) {
    const res = await sendRequestBounded<Msg<'CODE_REFS_RESULT'>>(
      { type: 'RESOLVE_CODE_REFS', keys, ...(environment ? { environment } : {}) }, { timeoutMs: ENRICH_TIMEOUT_MS });
    if (res?.type !== 'CODE_REFS_RESULT' || !res.ok) throw new Error(res?.type === 'CODE_REFS_RESULT' && res.error ? res.error : NO_ANSWER);
    return res.results;
  },
  async listReferenced(items) {
    const res = await sendRequestBounded<Msg<'REFERENCED_DATA'>>({ type: 'LIST_REFERENCED', items }, { timeoutMs: OPEN_TIMEOUT_MS });
    if (res?.type !== 'REFERENCED_DATA' || !res.ok) throw new Error(res?.type === 'REFERENCED_DATA' && res.error ? res.error : NO_ANSWER);
    return { rows: res.rows, nodes: res.nodes };
  },
  async applications(rid) {
    const res = await sendRequestBounded<Msg<'PROPERTY_APPLICATIONS_RESULT'>>(
      { type: 'FETCH_PROPERTY_APPLICATIONS', rid, ...(environment ? { environment } : {}) }, { timeoutMs: OPEN_TIMEOUT_MS * 2 });
    if (res?.type !== 'PROPERTY_APPLICATIONS_RESULT' || !res.ok) throw new Error(res?.type === 'PROPERTY_APPLICATIONS_RESULT' && res.error ? res.error : NO_ANSWER);
    const applications = res.applications ?? [];
    return { applications, total: res.total ?? applications.length, truncated: !!res.truncated };
  },
  async pins() {
    const res = await sendRequestBounded<Msg<'FAVORITES_DATA'>>({ type: 'GET_FAVORITES' }, { timeoutMs: ENRICH_TIMEOUT_MS });
    return res?.type === 'FAVORITES_DATA' ? res.entries.map(e => e.rid) : [];
  },
  async togglePin(obj) {
    const res = await sendRequestBounded<Msg<'FAVORITES_DATA'>>({
      type: 'TOGGLE_FAVORITE', rid: obj.rid, name: obj.name, objectType: obj.type, businessId: obj.businessId,
      ...(obj.templateBusinessId ? { templateBusinessId: obj.templateBusinessId } : {}),
    }, { timeoutMs: ENRICH_TIMEOUT_MS });
    if (res?.type !== 'FAVORITES_DATA') throw new Error(NO_ANSWER);
    return res.entries.map(e => e.rid);
  },
};

/** Current position (service worker, lib/current-position.ts): the node the
 *  user selected in this window, on the window's tab. */
let positionTimer = 0;
let positionRid = '';
function reportPosition(obj: FullObject, now: boolean): void {
  window.clearTimeout(positionTimer);
  const send = () => {
    if (positionRid === obj.rid) return;
    positionRid = obj.rid;
    sendFireForget({ type: 'SET_CONTEXT_RID', rid: obj.rid, name: obj.name, objectType: obj.type, businessId: obj.businessId, source: 'window' });
  };
  if (now) send(); else positionTimer = window.setTimeout(send, POSITION_DELAY_MS);
}

// ── access mode: the data source ──────────────────────────────────

const RECENTS_KEY = 'crev_access_mode_recents';
const subjectKey = (env: string) => `crev_access_mode_subject:${env}`;
/** Recents are kept per connection profile (the part of the environment
 *  token before "@"). */
const profileOf = (env: string) => env.split('@')[0] || env;

const accessSource: AccessSource = {
  async status(env) {
    const res = await sendRequestBounded<Msg<'ACCESS_MODE_READY'>>({ type: 'ACCESS_MODE_STATUS', environment: env }, { timeoutMs: 5_000 });
    return res?.type === 'ACCESS_MODE_READY' ? { available: res.available, reason: res.reason } : {};
  },
  async prepare(env) {
    const res = await sendRequestBounded<Msg<'ACCESS_MODE_READY'>>({ type: 'ACCESS_MODE_PREPARE', environment: env }, { timeoutMs: ACCESS_TIMEOUT_MS });
    if (res?.type !== 'ACCESS_MODE_READY' || !res.ok || !res.subjects) throw new Error(res?.type === 'ACCESS_MODE_READY' && res.error ? res.error : NO_ANSWER);
    return { subjects: res.subjects, available: res.available !== false, reason: res.reason, environmentName: res.environmentName };
  },
  async decide(req) {
    const res = await sendRequestBounded<Msg<'ACCESS_MODE_DECISIONS'>>({ type: 'ACCESS_MODE_DECIDE', ...req }, { timeoutMs: ACCESS_TIMEOUT_MS });
    if (res?.type !== 'ACCESS_MODE_DECISIONS') throw new Error(NO_ANSWER);
    return res;
  },
  async trace(req) {
    const res = await sendRequestBounded<Msg<'ACCESS_MODE_TRACE_DATA'>>({ type: 'ACCESS_MODE_TRACE', ...req }, { timeoutMs: ACCESS_TIMEOUT_MS });
    if (res?.type !== 'ACCESS_MODE_TRACE_DATA') throw new Error(NO_ANSWER);
    return res;
  },
  async loadPrefs(env) {
    const out: AccessPrefs = { recents: [] };
    try {
      const subject = (await chrome.storage.session.get(subjectKey(env)))[subjectKey(env)] as AccessSubject | undefined;
      if (subject && typeof subject.rid === 'string' && /^\d+$/.test(subject.rid) && (subject.kind === 'user' || subject.kind === 'role')) out.subject = subject;
    } catch { /* session storage unavailable */ }
    try {
      const all = (await chrome.storage.local.get(RECENTS_KEY))[RECENTS_KEY] as Record<string, string[]> | undefined;
      const list = all?.[profileOf(env)];
      if (Array.isArray(list)) out.recents = list.filter(r => typeof r === 'string' && /^\d+$/.test(r));
    } catch { /* local storage unavailable */ }
    return out;
  },
  savePrefs(env, prefs) {
    const key = subjectKey(env);
    void (prefs.subject ? chrome.storage.session.set({ [key]: prefs.subject }) : chrome.storage.session.remove(key)).catch(() => { /* best effort */ });
    void chrome.storage.local.get(RECENTS_KEY).then(got => {
      const all = { ...(got[RECENTS_KEY] as Record<string, string[]> | undefined), [profileOf(env)]: prefs.recents };
      return chrome.storage.local.set({ [RECENTS_KEY]: all });
    }).catch(() => { /* best effort */ });
  },
};

const accessMode = new AccessMode(accessSource);

async function storedHint(rid: string): Promise<WindowHint | undefined> {
  try {
    const key = `crev_objectview_ctx_${rid}`;
    const stored = (await chrome.storage.local.get(key))[key] as { name?: string; type?: string; businessId?: string } | undefined;
    if (!stored) return undefined;
    return { name: stored.name || undefined, type: stored.type || undefined, businessId: stored.businessId || undefined };
  } catch {
    return undefined;
  }
}

/** Esc closes the window only when no edit, field, menu or dialog has it. */
function escapeClosesWindow(e: KeyboardEvent | null, view: ObjectWindowView): boolean {
  if (!e || view.editing || isTypingIn(e)) return false;
  return !document.querySelector('.crev-modal-backdrop, .cp-popover, .ip-popover');
}

const colorCatalogue = new WorkspaceColorCatalogue();

/** The image files, read when the picker of a button's image is first opened. */
const imageCatalogue = new ImageCatalogue(
  new ThumbCache(async rids => (await sendRequest<Msg<'IMAGE_BYTES_DATA'>>({ type: 'IMAGE_BYTES', rids }))?.items
    ?? rids.map(rid => ({ rid, error: 'No answer from the extension' }))),
  async () => {
    const r = await sendRequest<Msg<'IMAGE_INDEX_DATA'>>({ type: 'IMAGE_INDEX' });
    if (!r?.ok) throw new Error(r?.error ?? 'The image files could not be read');
    return { folders: r.folders ?? [], files: r.files ?? [], ...(r.error ? { error: r.error } : {}) };
  },
);

/** Back to the code search window that opened this one (it stays open
 *  behind, with its results and selection). */
function backToSearch(origin: ObjectWindowOrigin): void {
  sendFireForget({ type: 'OPEN_CODE_SEARCH', restore: true, ...(origin.mode === 'text' && origin.query ? { query: origin.query } : {}) });
}

function boot(): void {
  // The theme is the document's own (crev-light, as on the other extension
  // pages); it does not follow the operating system.
  const root = document.getElementById('objectwindow-root')!;
  root.removeAttribute('aria-busy');
  let controller: ObjectWindowController;
  let recorded = '';
  const view = new ObjectWindowView(root, {
    navigate: (rid, trail) => { void controller.open(rid, undefined, true, trail); },
    back: () => { void controller.back(); },
    forward: () => { void controller.forward(); },
    retry: () => { void controller.retry(); },
    retryNames: rids => { void controller.retryNames(rids); },
    copy: text => copyText(text),
    openInEditor: (rid, property, type) => sendFireForget(hasStudio(type)
      ? { type: 'OPEN_STUDIO', rid, property }
      : { type: 'OPEN_EDITOR', rid, property }),
    openBlueprint: rid => sendFireForget({ type: 'OPEN_BLUEPRINT_FOR', rid }),
    selected: obj => {
      controller.nodeSelected(obj);
      // In Template mode the pane shows the template; the position stays the node.
      const rid = view.selectedRid;
      if (obj && (!rid || obj.rid === rid)) reportPosition(obj, false);
    },
    scanInbound: obj => controller.scanInbound(obj),
    usedInCode: obj => controller.loadInCode(obj),
    cancelInbound: rid => controller.cancelInbound(rid),
    loadApplications: rid => controller.loadApplications(rid),
    togglePin: () => controller.togglePin(),
    reloadPage: () => sendFireForget({ type: 'RELOAD_BMP_TAB' }),
    followRefs: items => controller.followReferences(items),
    reveal: (target, trail, attach, hops) => controller.reveal(target, trail, attach, hops),
    selectionChanged: (sel, trail, via) => controller.selectionChanged(sel, trail, via),
    neighbour: dir => controller.neighbour(dir),
    toOrigin: origin => backToSearch(origin),
    findReferences: (obj, from) => sendFireForget({ type: 'OPEN_CODE_SEARCH', mode: 'refs', target: obj, ...(from ? { context: from } : {}) }),
    searchCode: (obj, under) => sendFireForget({ type: 'OPEN_CODE_SEARCH', mode: 'text', ...(obj ? { context: obj } : {}), ...(obj && under ? { scope: obj } : {}) }),
    atlas: obj => sendFireForget({ type: 'OPEN_ATLAS', rid: obj.rid, ...(obj.name ? { name: obj.name } : {}), ...(obj.type ? { objectType: obj.type } : {}) }),
    requestFields: obj => controller.requestFields(obj),
    needTemplate: rid => controller.ensureTemplate(rid),
    edit: (rid, prop, value, base) => controller.edit(rid, prop, value, base),
    editCustom: (rid, prop, value) => controller.editCustom(rid, prop, value),
    loadAllowed: (rid, prop, opts) => controller.loadAllowed(rid, prop, opts),
    referenceRow: (rid, prop) => controller.referenceRow(rid, prop),
    editReferences: (rid, prop, rids) => controller.editReferences(rid, prop, rids),
    revert: (rid, prop) => controller.revert(rid, prop),
    toggleReset: (rid, prop, base) => controller.toggleReset(rid, prop, base),
    discard: () => { void controller.discard(); },
    save: () => { void controller.save(); },
    setTarget: t => controller.setTarget(t),
    // Compare: this object is side A; B is its template or the picker.
    compare: (kind, obj) => {
      const left = { rid: obj.rid, name: obj.name, type: obj.type, businessId: obj.businessId };
      const tpl = kind === 'template' ? templateRidOf(obj) : undefined;
      sendFireForget({ type: 'OPEN_COMPARE', left, ...(tpl ? { right: { rid: tpl } } : {}) });
    },
    // Role and AccessPolicy: the Access workspace (the view toggles access
    // mode for every other object).
    access: obj => sendFireForget({ type: 'OPEN_ACCESS_WORKSPACE', ...(environment ? { environment } : {}),
      destination: accessDestinationForObject({ rid: obj.rid, name: obj.name, type: obj.type, businessId: obj.businessId }) }),
    imageEditor: spec => {
      // The button's own background color: its ID is read when the picker opens (one small read), then its value from the color list.
      let colorBid = spec.colorBid;
      return createImageEditor({
        ...spec,
        catalogue: imageCatalogue,
        background: () => (colorBid ? colorCatalogue.rgb(colorBid) : null),
        beforeOpen: async () => {
          if (!colorBid && spec.colorRid) {
            const res = await sendRequestBounded<Msg<'OBJECT_SUMMARIES_DATA'>>({ type: 'READ_OBJECT_SUMMARIES', rids: [spec.colorRid] }, { timeoutMs: ENRICH_TIMEOUT_MS }).catch(() => undefined);
            if (res?.type === 'OBJECT_SUMMARIES_DATA' && res.ok) colorBid = res.summaries.find(s => s.rid === spec.colorRid)?.businessId ?? '';
          }
          if (colorBid && colorCatalogue.rgb(colorBid) === null) {
            await colorCatalogue.load(force => sendRequest<Msg<'COLOR_SETS_DATA'>>({ type: 'FETCH_COLOR_SETS', ...(force ? { force: true } : {}) }));
          }
        },
      onOpenImages: () => sendFireForget({ type: 'OPEN_COLORS_IMAGES', tab: 'images' }),
      });
    },
    pickColor: (anchor, currentBid, apply) => openColorPicker({
      anchor, currentBid, catalogue: colorCatalogue,
      sendMessage: message => {
        if (message.type !== 'FETCH_COLOR_SETS') return;
        void colorCatalogue.load(
          force => sendRequest<Msg<'COLOR_SETS_DATA'>>({ type: 'FETCH_COLOR_SETS', ...(force ? { force: true } : {}) }),
          message.force === true,
        );
      },
      onPick: apply,
    }),
  }, {
    access: {
      mode: accessMode,
      handlers: {
        openRule: destination => sendFireForget({ type: 'OPEN_ACCESS_WORKSPACE', ...(environment ? { environment } : {}), destination }),
        openTest: node => sendFireForget({ type: 'OPEN_ACCESS_WORKSPACE', ...(environment ? { environment } : {}),
          destination: accessDestinationForObject({ rid: node.rid, name: node.name, type: node.type, businessId: node.businessId }) }),
        copy: text => copyText(text),
      },
    },
  });
  controller = new ObjectWindowController(view, source, {
    onRoot: obj => {
      const name = obj.name || obj.businessId || '(unnamed)';
      document.title = `${name} - Companion`;
      // The host titlebar follows the object shown; it changes only here,
      // once the window has really switched (a cancelled dirty guard keeps it).
      postTitleToParent(`${obj.type || 'Object'} · ${name}`);
      // The hash follows in-frame navigation without reloading the frame,
      // so a reload of the frame reopens the object shown.
      const hash = `#${encodeURIComponent(obj.rid)}`;
      if (location.hash !== hash) history.replaceState(history.state, '', hash);
      // A root the window opened is a recent object and the current position.
      if (recorded !== obj.rid) {
        recorded = obj.rid;
        sendFireForget({ type: 'RECORD_RECENT', rid: obj.rid, name: obj.name, objectType: obj.type, businessId: obj.businessId });
        reportPosition(obj, true);
      }
    },
    confirmSave: review => confirmCommandModal({
      title: review.title, body: review.body, confirmLabel: review.confirmLabel, confirmVariant: review.confirmVariant,
    }),
    resolveConflict: async conflict => (await choiceModal({
      title: conflict.title, body: conflict.body, choices: conflict.choices,
    })) ?? 'cancel',
    onOrigin: origin => backToSearch(origin),
    confirmDiscard: (n, reason) => confirmModal({
      title: discardTitle(n),
      body: reason === 'navigate' ? 'Opening another object drops the unsaved changes of this one. Nothing has been written to BMP.' : 'The unsaved changes go back to the stored values.',
      confirmLabel: DISCARD_LABEL, cancelLabel: KEEP_EDITING_LABEL, confirmVariant: 'danger',
    }),
  });

  controller.loadPins();
  const rid = decodeURIComponent(location.hash.slice(1));
  // The stored title hint (name/type) paints the header and lets the service
  // worker skip one round trip. It is a local storage read, so wait at most
  // a few frames for it; the read never depends on it.
  const hintTimeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 60));
  void Promise.race([storedHint(rid), hintTimeout]).then(hint => controller.open(rid, hint));

  // Opening another object while the window is live: navigate in-frame
  // (the controller asks first when edits are pending).
  window.addEventListener('message', (event: MessageEvent) => {
    if (!fromParent(event)) return;
    const msg = event.data as { type?: string; activation?: ObjectWindowFrameActivation } | undefined;
    if (msg?.type !== 'CREV_FRAME_ACTIVATE' || msg.activation?.type !== 'objectview') return;
    const a = msg.activation;
    if (!a.rid) return;
    // The Extended Code window's "Open": select the object in this tree, or
    // hang it under the calling object; otherwise open it as root.
    if (a.reveal && view.revealFromOutside(a.rid, a.from)) return;
    // A change to review (Point and tell): staged in the draft once the object is read; the window's own review and save follow.
    if (a.draft) {
      controller.stageDraft(a.rid, a.draft.prop, a.draft.value);
      if (a.rid !== controller.current) void controller.open(a.rid, { name: a.name, type: a.objectType, businessId: a.businessId });
      return;
    }
    // A code search match: land on its property and line.
    if (a.focus || a.origin) {
      void controller.land(a.rid, { name: a.name, type: a.objectType, businessId: a.businessId }, { ...(a.focus ? { focus: a.focus } : {}), ...(a.origin ? { origin: a.origin } : {}) });
      return;
    }
    if (a.rid === controller.current) return;
    void controller.open(a.rid, { name: a.name, type: a.objectType, businessId: a.businessId });
  });
  // Mouse back/forward buttons and the history keys follow the in-frame
  // history; the keys never fire while typing in a field or code editor.
  // Ctrl/Cmd+S does what the Save button does (finish edits, review, save);
  // in a field it never reaches the browser's Save Page dialog.
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented) return;
    const id = whichShortcut(e, ['object.back', 'object.forward', 'object.save']);
    if (!id) return;
    e.preventDefault();
    if (id === 'object.back') void controller.back();
    else if (id === 'object.forward') void controller.forward();
    else view.requestSave();
  });
  window.addEventListener('mouseup', e => {
    if (e.button === 3) void controller.back();
    else if (e.button === 4) void controller.forward();
  });
  // Closing the frame (or the page going away) with pending edits asks first.
  installDirtyGuards({
    isDirty: () => controller.dirtyCount > 0,
    count: () => controller.dirtyCount,
    bodyText: 'Closing the object window loses the unsaved changes. Nothing has been written to BMP.',
  });
  // Escape: the window is the outermost layer (view.ts registers the inner
  // ones); `?` lists the keys of this window.
  const layers = escapeLayers();
  layers.register({
    kind: 'window', name: 'object-window',
    isOpen: () => true,
    close: e => {
      if (!escapeClosesWindow(e, view)) return false;
      postToParent({ type: 'CREV_OVERLAY_CLOSE_PLEASE' });
    },
  });
  layers.listen(document);
  installCheatSheetKey(() => ({ window: 'object', title: 'Object window: keyboard shortcuts' }));
  postToParent({ type: 'CREV_FRAME_READY' });
}

boot();
