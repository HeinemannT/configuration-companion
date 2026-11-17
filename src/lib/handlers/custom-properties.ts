/**
 * Custom property handlers for the object window:
 *  - FETCH_PROPERTY_SCHEMA: the type's property schema (read-only, cached
 *    per profile for the connection, custom-property-gate.ts);
 *  - APPLY_CUSTOM_CHANGES: the write of custom property values. The service
 *    worker is the gate: it reads the object (its own type and its current
 *    values), takes that type's field description as read in this session
 *    (read again when older than GATE_SCHEMA_MAX_AGE_MS), and refuses every
 *    change that is not a custom, editable, supported field of that type
 *    with a value that fits. When the window sends the values it opened
 *    (`expect`), the same read is the changed-since-opened check.
 *    A window inside a page may write only an object it read on the same
 *    environment (sender-trust.ts); a content script may not send it.
 *
 *  - FETCH_ALLOWED_OBJECTS: the objects a reference property allows for one
 *    object (display; read each time, no worker cache). Whether they come
 *    from the definition's expression or from its allowed types ("by type")
 *    the worker takes from the schema (allowedSources); the window sends
 *    only the definition.
 *
 * Posts per write (schema read in this session): the object read and the
 * write. The window's read after the save is the third. A write with N > 0
 * reference changes (reference, user/group, list of references) adds ONE
 * post for the allowed objects of all N (BmpClient.readAllowedObjectSets):
 * four posts in all, whatever N is and whichever mode each definition has
 * (expression and by-type scripts share that post). On a server without
 * `lookup()` the definitions with an expression and the written objects are
 * resolved first (TreeItemCommand posts, up to 25 objects each); by-type
 * definitions need no resolution.
 */

import { register } from '../handler-registry';
import { ctxOf } from '../sw-context';
import { errorMessage } from '../logger';
import { errorKindOf } from '../error-kind';
import { ENVIRONMENT_CHANGED_ERROR, environmentMatches, environmentMismatchError, environmentToken } from '../environment';
import { isRidShaped } from '../validate-inbound';
import { activityObject, activityObjectLabel } from '../activity-format';
import { noteSavedObject } from '../code-index-service';
import { CHANGED_IN_BMP, compareOpened, isOutcomeUnknown, MAY_HAVE_SAVED, type ValueChange } from '../save-check';
import { frameMayWrite } from '../sender-trust';
import { allowedSources, checkCustomChanges, editableReferenceSource, GATE_SCHEMA_MAX_AGE_MS, referenceDefinitions, typeSchema } from '../custom-property-gate';
import {
  ABSENT, HISTORICAL_CUSTOM_WRITES, isEditKind, isReferenceKind, MAX_CUSTOM_CHANGES, ownValue, referenceRids, storedEquals, storedValue,
  type AllowedObjects, type AllowedSource, type CustomChange,
} from '../property-schema';
import type { FullObject } from '../object-read';
import type { BmpClient } from '../bmp-client';

const VALID_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The values the window opened (`expect`, definition → canonical stored
 *  value) that the object read now differs from. Only definitions of the
 *  sent changes are compared, each by its gated kind; the comparison is the
 *  window's own (save-plan.ts checkAgainstRead). Nothing sent: nothing to
 *  compare. */
export function changedSinceOpened(expect: unknown, changes: readonly CustomChange[], current: FullObject): ValueChange[] {
  if (!expect || typeof expect !== 'object' || Array.isArray(expect)) return [];
  const kinds = new Map(changes.filter(c => typeof c?.definition === 'string' && isEditKind(c.kind)).map(c => [c.definition, c.kind]));
  const opened: Record<string, string> = {};
  for (const [def, value] of Object.entries(expect as Record<string, unknown>)) {
    if (kinds.has(def) && typeof value === 'string') opened[def] = value;
  }
  const check = compareOpened(opened, def => storedValue(current, def, kinds.get(def)!),
    (def, a, b) => a === b || (a !== ABSENT && b !== ABSENT && storedEquals(kinds.get(def)!, a, b)));
  return check.state === 'changed' ? check.changes : [];
}
/** The allowed objects of `defs` for object `rid` (one post; `sources`
 *  says which are by type); a read that throws as a whole is the Error of
 *  every definition, so the gate refuses those changes with its reason
 *  instead of failing the post. */
async function readAllowed(
  client: Pick<BmpClient, 'readAllowedObjectSets'>, rid: string, defs: readonly string[], sources: ReadonlyMap<string, AllowedSource>,
): Promise<Map<string, AllowedObjects | Error>> {
  if (!defs.length) return new Map();
  try { return await client.readAllowedObjectSets(rid, defs, undefined, sources); }
  catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return new Map(defs.map(d => [d, error]));
  }
}

/** A window frame asked to write an object the worker never served to it. */
export const NOT_OPENED = 'This window has not opened this object. Reload the window.';

/** The local calendar date (YYYY-MM-DD): the effective date a historical
 *  write would use while HISTORICAL_CUSTOM_WRITES is on. */
function todayIso(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

register('FETCH_PROPERTY_SCHEMA', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const fail = (error: string) => respond({ type: 'PROPERTY_SCHEMA_RESULT', className: String(msg.className), ok: false, error, environment });
  if (!ctx.client) { fail('Not connected to BMP'); return; }
  if (!environmentMatches(ctx, msg.environment)) { fail(environmentMismatchError(ctx, msg.environment)); return; }
  if (typeof msg.className !== 'string' || !VALID_TYPE.test(msg.className)) { fail('Invalid type name'); return; }
  try {
    const schema = await typeSchema(ctx.client, msg.className);
    if (!environmentMatches(ctxOf(meta), environment)) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
    respond({ type: 'PROPERTY_SCHEMA_RESULT', className: msg.className, ok: true, schema, environment });
  } catch (e) {
    fail(errorMessage(e));
  }
});

register('FETCH_ALLOWED_OBJECTS', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const environment = environmentToken(ctx);
  const rid = typeof msg.rid === 'string' ? msg.rid : '';
  const definition = typeof msg.definition === 'string' ? msg.definition : '';
  const fail = (error: string) => respond({ type: 'ALLOWED_OBJECTS_RESULT', rid, definition, ok: false, error, environment });
  if (!ctx.client) { fail('Not connected to BMP'); return; }
  if (!environmentMatches(ctx, msg.environment)) { fail(environmentMismatchError(ctx, msg.environment)); return; }
  if (!isRidShaped(rid)) { fail(`Not an object RID: ${rid}`); return; }
  if (typeof msg.className !== 'string' || !VALID_TYPE.test(msg.className)) { fail('Invalid type name'); return; }
  if (meta.senderKind === 'content') { fail('This request is not accepted from a page.'); return; }
  // A window inside a page reads only an object it was served.
  if (meta.senderKind === 'frame' && !(await frameMayWrite({ tabId: meta.senderTabId, frameId: meta.senderFrameId, documentId: meta.senderDocumentId, url: meta.senderUrl }, environment, rid))) {
    fail(NOT_OPENED);
    return;
  }
  try {
    // Only an editable reference property of the named type is read (the
    // type's schema as read in this session), by its expression or its types.
    const schema = await typeSchema(ctx.client, msg.className);
    const source = editableReferenceSource(schema, definition);
    if (!source) { fail('Not an editable reference property of this type.'); return; }
    const read = await ctx.client.readAllowedObjects(rid, definition, undefined, source);
    if (!environmentMatches(ctxOf(meta), environment)) { fail(ENVIRONMENT_CHANGED_ERROR); return; }
    respond({ type: 'ALLOWED_OBJECTS_RESULT', rid, definition, ok: true, items: read.items, ...(read.tooMany ? { tooMany: true } : {}), environment });
  } catch (e) {
    fail(errorMessage(e));
  }
});

register('APPLY_CUSTOM_CHANGES', async (msg, respond, meta) => {
  const ctx = ctxOf(meta);
  const rid = typeof msg.rid === 'string' ? msg.rid : '';
  const refuse = (error: string, refused?: Array<{ definition: string; reason: string }>) =>
    respond({ type: 'APPLY_CUSTOM_CHANGES_RESULT', rid, ok: false, notSent: true, error, ...(refused?.length ? { refused } : {}) });
  if (!ctx.client) { refuse('Not connected to BMP'); return; }
  const environment = environmentToken(ctx);
  if (typeof msg.environment !== 'string' || !msg.environment || !environmentMatches(ctx, msg.environment)) {
    refuse(environmentMismatchError(ctx, msg.environment));
    return;
  }
  if (!isRidShaped(rid)) { refuse(`Not an object RID: ${rid}`); return; }
  if (meta.senderKind === 'frame' && !(await frameMayWrite({ tabId: meta.senderTabId, frameId: meta.senderFrameId, documentId: meta.senderDocumentId, url: meta.senderUrl }, environment, rid))) {
    // Named on every row of the post (definition ''): "Not saved: …".
    refuse(NOT_OPENED, [{ definition: '', reason: NOT_OPENED }]);
    return;
  }
  if (meta.senderKind === 'content') { refuse('This request is not accepted from a page.'); return; }
  const changes = Array.isArray(msg.changes) ? msg.changes.slice(0, MAX_CUSTOM_CHANGES + 1) : [];
  if (changes.length > MAX_CUSTOM_CHANGES) { refuse(`At most ${MAX_CUSTOM_CHANGES} changes per write.`); return; }
  const client = ctx.client;
  const object = activityObject(rid, ctx.cache.get(rid), msg.objectLabel);
  const label = activityObjectLabel(object, rid);

  // The gate: the object's own type, read now (never the window's word for
  // it), and that type's field description as read in this session within
  // GATE_SCHEMA_MAX_AGE_MS (read again when older). The same object read is
  // the changed-since-opened check (`expect`).
  let gate: ReturnType<typeof checkCustomChanges>;
  let current: FullObject;
  try {
    const { objects, errors } = await client.readFullObjects([rid]);
    const obj = ownValue(objects, rid);
    if (!obj) { refuse(ownValue(errors, rid) ?? 'The object could not be read.'); return; }
    current = obj;
    if (!VALID_TYPE.test(obj.type)) { refuse(`Unexpected type: ${obj.type}`); return; }
    const schema = await typeSchema(client, obj.type, { maxAgeMs: GATE_SCHEMA_MAX_AGE_MS });
    // The objects each changed reference property allows for THIS object,
    // read now in one post (never a cached set: it depends on the object's
    // current data). A failed read refuses only its own change.
    const refDefs = referenceDefinitions(schema, changes);
    const allowed = await readAllowed(client, rid, refDefs, allowedSources(schema, refDefs));
    // The objects each changed list of references holds now (this read): a
    // list may keep them although the property no longer allows them.
    const stored = new Map<string, string[]>();
    for (const c of changes) {
      if (c?.kind !== 'referenceList' || typeof c.definition !== 'string' || !refDefs.includes(c.definition)) continue;
      stored.set(c.definition, (ownValue(obj.references, c.definition) ?? []).filter((r): r is string => typeof r === 'string'));
    }
    // List items and objects in the form this server accepts: lookup(<rid>),
    // or the pre-lookup reference of an older server. Only RIDs that are
    // members of the property's own list set or allowed set (or kept in a
    // list it holds now) are resolved (the gate checks again). Own keys
    // only: a definition such as
    // `constructor` finds no list and gets the gate's own refusal.
    const members = new Set<string>();
    for (const c of changes) {
      if (typeof c?.value !== 'string') continue;
      if (c.kind === 'listItem' && ownValue(schema.listItems, c.definition)?.some(i => i.rid === c.value)) members.add(c.value);
      const set = isReferenceKind(c.kind) && typeof c.definition === 'string' ? allowed.get(c.definition) : undefined;
      if (set && !(set instanceof Error)) {
        const ok = new Set(set.items.map(i => i.rid));
        for (const r of stored.get(c.definition) ?? []) ok.add(r);
        for (const r of referenceRids(c.value)) if (ok.has(r)) members.add(r);
      }
    }
    const refs = members.size ? await client.resolveRefs([...members]) : new Map<string, string | Error>();
    const itemRef = (r: string) => { const v = refs.get(r); return typeof v === 'string' ? v : undefined; };
    gate = checkCustomChanges(schema, changes, { itemRef, allowed, stored, ...(HISTORICAL_CUSTOM_WRITES ? { effectiveDate: todayIso() } : {}) });
  } catch (e) {
    refuse(`The property schema could not be read: ${errorMessage(e)}`);
    return;
  }
  if (!gate.ok) {
    const first = gate.refused[0];
    ctx.logActivity('warn', `Refused a property change on ${label}`, gate.refused.map(r => `${r.definition || 'change'}: ${r.reason}`).join('\n'), {
      category: 'change', action: 'edit-object', object,
    });
    refuse(first?.reason ?? 'The change was refused.', gate.refused);
    return;
  }
  // Changed since the window opened it: nothing is written; the window shows
  // the values and offers Review / Overwrite (an Overwrite sends no `expect`).
  const conflict = changedSinceOpened(msg.expect, changes, current);
  if (conflict.length) {
    respond({ type: 'APPLY_CUSTOM_CHANGES_RESULT', rid, ok: false, notSent: true, error: `Not saved: ${CHANGED_IN_BMP}.`, conflict, object: current });
    return;
  }
  if (!environmentMatches(ctxOf(meta), environment)) { refuse(ENVIRONMENT_CHANGED_ERROR); return; }

  const startedAt = Date.now();
  const names = changes.map(c => c.accessor);
  const summary = names.length === 1 ? names[0] : `${names.length} props (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})`;
  try {
    const result = await client.applyCustomChanges(rid, gate.lines);
    const durationMs = Date.now() - startedAt;
    respond({
      type: 'APPLY_CUSTOM_CHANGES_RESULT', rid, ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
      ...(result.notSent ? { notSent: true } : {}),
      ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    });
    if (result.ok) {
      if (result.warning) ctx.logActivity('warn', `BMP warned while saving ${label}`, result.warning, { category: 'change', action: 'edit-object', object });
      // A custom value is not part of the object's identity (name, ID, type,
      // template), so the badge names are not read again: no post. The
      // window's own read after the save verifies the stored values.
      noteSavedObject(rid, undefined, ctx);
      ctx.logActivity('success', `Edited ${label}: ${summary} (${durationMs}ms)`, undefined, { category: 'change', action: 'edit-object', object, durationMs });
    } else {
      ctx.logActivity('error', `Edit failed on ${label}: ${summary} (${durationMs}ms)`, result.error, { category: 'change', action: 'edit-object', object, durationMs });
      ctx.toast(result.outcomeUnknown ? MAY_HAVE_SAVED : `Save failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  } catch (e) {
    const unknown = isOutcomeUnknown(errorKindOf(e));
    respond({ type: 'APPLY_CUSTOM_CHANGES_RESULT', rid, ok: false, error: errorMessage(e), ...(unknown ? { outcomeUnknown: true } : {}) });
    ctx.logActivity('error', `Edit request failed on ${label}`, errorMessage(e), { category: 'change', action: 'edit-object', object });
    ctx.toast(unknown ? `${MAY_HAVE_SAVED} ${errorMessage(e)}` : `Save threw: ${errorMessage(e)}`, 'error');
  }
});
