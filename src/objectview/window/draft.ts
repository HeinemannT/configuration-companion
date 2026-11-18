/**
 * Object window — the one draft for the whole window, and the edit policy.
 *
 * The draft is keyed by object rid and property name, so the root, several
 * children and the root's template can hold pending edits at the same time.
 * Each entry stores the value it replaces (`base`), so every edit has its
 * own revert and the review can show "from → to" without another read.
 *
 * `editability` decides what may enter the draft at all. Only three kinds of
 * property are editable, each tied to an existing write route:
 *  - identity (`name`, `id`)            → SAVE_IDENTITY, pencil only;
 *  - code shown as a Behaviour block    → SAVE_PROPERTY;
 *  - the pane-schema properties (src/lib/pane-schema.ts; a plain one-line
 *    `description` among them), plus the
 *    gates of the drawn expression blocks → APPLY_OBJECT_CHANGES.
 * A property that the object read did not return is never editable: that is
 * the guard for older BMP versions where properties are missing.
 *
 * Pure: no DOM, no chrome.*.
 */

import type { FullObject, PropValue } from '../../lib/object-read';
import { EXPRESSIONS, listsTextField, tableBlocks, typeInfo } from '../../lib/object-window-table';
import { findPropDef, OBJECT_TEXT_PROPS_SET, type PropDef } from '../../lib/pane-schema';
import { paneValueEquals } from '../../lib/pane-edit';
import { storedEquals, type EditKind } from '../../lib/property-schema';

export type EditRoute = 'identity' | 'code' | 'props';

export interface Editability {
  route: EditRoute;
  /** Pane schema entry (typed editor, enum options, ranges) for `props`. */
  def?: PropDef;
  /** Several plain lines: edited in a text area. */
  multiline?: boolean;
  /** True for an expression gate (`useShowExpression` …). */
  gate?: boolean;
}

/** Gate properties of the expression blocks. These are the only properties
 *  that APPLY_OBJECT_CHANGES accepts beyond the pane-schema set. */
export const GATE_PROPS: ReadonlySet<string> = new Set(
  Object.values(EXPRESSIONS).flatMap(d => (d.gate ? [d.gate] : [])),
);

/** Display/compare text of a read value (booleans as "true"/"false"). */
export function baseText(v: PropValue | undefined): string {
  if (!v) return '';
  if (v.kind === 'boolean') return String(v.bool ?? v.text === 'true');
  return v.text;
}

/** Whether `prop` of `obj` may be edited in the object window, and how. */
export function editability(obj: FullObject, prop: string): Editability | null {
  if (!Object.hasOwn(obj.props, prop)) return null;
  if (prop === 'name' || prop === 'id') return { route: 'identity' };
  const v = obj.props[prop];
  if (v.kind === 'code' && tableBlocks(typeInfo(obj.type), obj).includes(prop)) return { route: 'code' };
  if (GATE_PROPS.has(prop)) {
    const gated = Object.entries(EXPRESSIONS).some(([p, d]) => d.gate === prop && Object.hasOwn(obj.props, p));
    return gated && v.kind === 'boolean' ? { route: 'props', gate: true } : null;
  }
  const def = findPropDef(prop);
  if (!def || def.kind === 'text') return null;
  if (def.availableOn && !def.availableOn.has(obj.type)) return null;
  if (OBJECT_TEXT_PROPS_SET.has(prop)) {
    // A built-in text field: only where the table lists it, as one plain line.
    if (!listsTextField(obj.type, prop) || v.kind !== 'text') return null;
    return MARKUP.test(v.text) || LINE_BREAK.test(v.text) ? null : { route: 'props', def };
  }
  if (prop === 'description') {
    // Markup is shown, not edited. Plain text opens in a text area that takes line breaks.
    if (MARKUP.test(v.text)) return null;
    return { route: 'props', def, multiline: true };
  }
  return { route: 'props', def };
}

const MARKUP = /<[a-z!/]/i;
const LINE_BREAK = /[\r\n]/;

/** Why a text property that looks editable is not: the text holds markup (or,
 *  for a built-in text field, line breaks). null when it is editable, or is
 *  not a text field of this object. */
export function readOnlyReason(obj: FullObject, prop: string): string | null {
  if (!Object.hasOwn(obj.props, prop)) return null;
  const v = obj.props[prop];
  const isText = prop === 'description' || (OBJECT_TEXT_PROPS_SET.has(prop) && listsTextField(obj.type, prop) && v.kind === 'text');
  if (!isText || editability(obj, prop)) return null;
  return MARKUP.test(v.text) ? 'Holds formatted text. Edit it in BMP.' : null;
}

/** The template an instance is linked to (model link first, then the
 *  enterprise template reference). */
export function templateRidOf(obj: FullObject | null | undefined): string | undefined {
  return obj?.references.linkedTo?.[0] ?? obj?.references.template?.[0];
}

/** Whether an override of `prop` on `obj` can be reset to the template value
 *  through the existing route. */
export function canReset(obj: FullObject, prop: string): boolean {
  if (!templateRidOf(obj) || !obj.overridden.includes(prop)) return false;
  return editability(obj, prop)?.route === 'props';
}

/** A custom property edit (custom route, APPLY_CUSTOM_CHANGES): typed, with
 *  the definition RID, accessor and kind the service worker checks again.
 *  `base` is the stored value it replaces in property-schema's canonical
 *  form (`storedValue`): text, "true"/"false", number text, item RID, or
 *  ABSENT for a property that is not set. */
export interface CustomEntry {
  kind: 'custom';
  value: string;
  base: string;
  definition: string;
  accessor: string;
  valueKind: EditKind;
}

export type DraftEntry =
  | { kind: 'value'; value: string; base: string }
  | { kind: 'reset'; base: string }
  | CustomEntry;

export interface DraftItem {
  rid: string;
  prop: string;
  entry: DraftEntry;
}

/** Read-only view of the draft handed to the view. */
export interface DraftView {
  get(rid: string, prop: string): DraftEntry | undefined;
  count(): number;
  countFor(rid: string): number;
  errorFor(rid: string): string | undefined;
  /** The server's refusal of one property's write, if any. */
  propErrorFor(rid: string, prop: string): string | undefined;
  items(): DraftItem[];
  /** Counts the times every entry was dropped at once (Discard, or a
   *  navigation that dropped the edits): an open inline editor started in
   *  an earlier generation holds text that is no longer staged. */
  readonly generation: number;
}

function sameValue(prop: string, a: string, b: string): boolean {
  return a === b || paneValueEquals(prop, a, b);
}

export class WindowDraft implements DraftView {
  private readonly map = new Map<string, Map<string, DraftEntry>>();
  private readonly errors = new Map<string, string>();
  /** `rid:prop` → the server's refusal of that property's write. */
  private readonly propErrors = new Map<string, string>();
  private cleared = 0;

  get generation(): number { return this.cleared; }

  /** Stage a value. A value equal to `base` removes the entry instead. */
  set(rid: string, prop: string, value: string, base: string): void {
    const props = this.map.get(rid) ?? new Map<string, DraftEntry>();
    if (sameValue(prop, value, base)) props.delete(prop);
    else props.set(prop, { kind: 'value', value, base });
    this.store(rid, props);
  }

  /** Stage a custom property value. A value equal to the stored one (by
   *  kind) removes the entry instead. */
  setCustom(rid: string, prop: string, entry: Omit<CustomEntry, 'kind'>): void {
    const props = this.map.get(rid) ?? new Map<string, DraftEntry>();
    if (storedEquals(entry.valueKind, entry.value, entry.base)) props.delete(prop);
    else props.set(prop, { kind: 'custom', ...entry });
    this.propErrors.delete(`${rid}:${prop}`);
    this.store(rid, props);
  }

  /** The server's refusal of one property's write (shown on its row). */
  setPropError(rid: string, prop: string, error: string | undefined): void {
    const k = `${rid}:${prop}`;
    if (error) this.propErrors.set(k, error);
    else this.propErrors.delete(k);
  }

  propErrorFor(rid: string, prop: string): string | undefined {
    return this.propErrors.get(`${rid}:${prop}`);
  }

  /** Stage "reset this override to the template value". */
  stageReset(rid: string, prop: string, base: string): void {
    const props = this.map.get(rid) ?? new Map<string, DraftEntry>();
    props.set(prop, { kind: 'reset', base });
    this.store(rid, props);
  }

  revert(rid: string, prop: string): void {
    const props = this.map.get(rid);
    if (!props) return;
    props.delete(prop);
    this.propErrors.delete(`${rid}:${prop}`);
    this.store(rid, props);
  }

  get(rid: string, prop: string): DraftEntry | undefined {
    return this.map.get(rid)?.get(prop);
  }

  count(): number {
    let n = 0;
    for (const props of this.map.values()) n += props.size;
    return n;
  }

  countFor(rid: string): number {
    return this.map.get(rid)?.size ?? 0;
  }

  items(): DraftItem[] {
    const out: DraftItem[] = [];
    for (const [rid, props] of this.map) for (const [prop, entry] of props) out.push({ rid, prop, entry });
    return out;
  }

  /** Remove submitted entries that still hold the submitted value. A value
   *  changed while the save was in flight stays staged. */
  commit(rid: string, submitted: ReadonlyArray<{ prop: string; entry: DraftEntry }>): void {
    const props = this.map.get(rid);
    if (!props) return;
    for (const { prop, entry } of submitted) {
      const cur = props.get(prop);
      if (!cur || cur.kind !== entry.kind) continue;
      if (cur.kind === 'reset' || (entry.kind !== 'reset' && cur.value === entry.value)) {
        props.delete(prop);
        this.propErrors.delete(`${rid}:${prop}`);
      }
    }
    this.store(rid, props);
  }

  setError(rid: string, error: string | undefined): void {
    if (error) this.errors.set(rid, error);
    else this.errors.delete(rid);
  }

  errorFor(rid: string): string | undefined {
    return this.errors.get(rid);
  }

  clear(): void {
    this.map.clear();
    this.errors.clear();
    this.propErrors.clear();
    this.cleared++;
  }

  private store(rid: string, props: Map<string, DraftEntry>): void {
    if (props.size) this.map.set(rid, props);
    else {
      this.map.delete(rid);
      this.errors.delete(rid);
    }
  }
}
