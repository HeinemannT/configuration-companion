/**
 * From an answer to staged changes: each operation is judged against the page (the allowlist of the
 * vocabulary, the layout rules, what the page looked like when it was copied) and, when it passes, applied
 * with the same pure edit functions Blueprint's own gestures use. One fold over a working model: an
 * operation sees the effect of the ones before it. The result is what the panel shows (per note, in plain
 * words) and what Blueprint is given (one model per note, so each note is one undo step).
 *
 * The answer is untrusted text. It is matched against allowlists and turned into edits; nothing in it is
 * ever run, and the Extended Code of an apply still comes only from Blueprint's compiler.
 */
import { diff } from '../layout/diff';
import { addContainer, addTab, addWidget, createTabset, insertRelative, isAncestorOf, moveInto, remove, rename, resize, setHeight, setStyle } from '../layout/edit';
import { descendantWidgets, editableTabsets, findNode, hasHeight, isFullGhost, isResultTab } from '../layout/model';
import { bandInsertIndex } from '../layout/placement';
import { computeRows } from '../layout/rows';
import { planStepId, type LModel, type LNode, type NodeStyle } from '../layout/types';
import { styleOptions } from '../style-props';
import { nowOf } from './payload';
import { normRef, resolveRef, tableOf, type RefTable } from './refs';
import { legal, slotIndex, BAND_CONTAINER, BAND_WIDGET } from './resolve';
import { routeOf, type Route } from './routes';
import type { PtAnswer, PtCopySnapshot, PtDraft, PtOp, PtRawPlace } from './types';
import { addTypes, changeableProps, isAddableWidget, newWidgetProps, type PtProp } from './vocabulary';

/** ok: staged in Blueprint. invalid: refused, with the reason. cannot: not possible. open: valid, made in another window the user reviews (the editor, the object window). */
export type PtVerdict = 'ok' | 'invalid' | 'cannot' | 'open';

export interface PtOpResult {
  op: PtOp;
  verdict: PtVerdict;
  /** The operation in plain words ("Change header color of ActionButton "Export" to Corporate blue"). */
  text: string;
  /** Why it was refused, or what cannot be done yet. */
  reason?: string;
  /** Allowed, with a consequence worth saying. */
  warning?: string;
  /** Object ids it touches (a staged add's temporary id included). */
  ids: string[];
  /** A change Blueprint cannot stage but another window can: its object, property and the value asked for. */
  route?: { kind: Route; id: string; className: string; name: string; property: string; value: string };
}

export interface PtNoteReport {
  /** The note's number; 0 for what names no note. */
  n: number;
  text?: string;
  results: PtOpResult[];
  questions: string[];
  cannot: string[];
  /** The answer said nothing about this note. */
  unaddressed: boolean;
}

export interface PtStageResult {
  /** One model per note that changed something: the model after that note's operations. */
  steps: Array<{ note: number; model: LModel }>;
  reports: PtNoteReport[];
  /** Object id (staged adds by their temporary id) -> the note that asked for it. */
  origins: Record<string, number>;
  final: LModel;
  ready: number;
  /** Valid changes that open another window (the editor, the object window) instead of being staged. */
  review: number;
  notPossible: number;
}

export interface StageEnv { colorName?: (bid: string) => string | undefined }

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

const PROP_WORDS: Record<PtProp, string> = {
  name: 'name', columns: 'columns', columnsMedium: 'columns on medium screens', columnsSmall: 'columns on small screens', height: 'height',
  headerColor: 'header color', fontColor: 'font color', shadow: 'shadow', headerStyle: 'header bar', borderStyle: 'border', transparency: 'transparency',
  showToolMenu: 'tools menu', disableSearch: 'search off', visibility: 'visibility',
  shownOnLargeDisplay: 'shown on large screens', shownOnMediumDisplay: 'shown on medium screens', shownOnSmallDisplay: 'shown on small screens',
};

const typed = (n: LNode): string => `${n.className} "${n.name}"`;

// ── Reading values ──────────────────────────────────────────────────────────────────────────────

function int(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}
function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s === 'true') return true; if (s === 'false') return false; }
  return null;
}
function member(v: unknown, prop: string): string | null {
  if (typeof v !== 'string') return null;
  const hit = styleOptions(prop).find(o => o.value === v.trim().toUpperCase());
  return hit?.value ?? null;
}

const show = (v: unknown): string => (v === undefined ? 'not set' : typeof v === 'string' ? `"${v}"` : String(v));

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

type Outcome =
  | { ok: true; model: LModel; text: string; ids: string[]; warning?: string; as?: { name: string; id: string } }
  | { ok: false; verdict: 'invalid' | 'cannot'; reason: string; text?: string; route?: PtOpResult['route'] }
  | { ok: false; verdict: 'open'; text: string; route: NonNullable<PtOpResult['route']>; reason?: undefined };

const fail = (reason: string, text?: string): Outcome => ({ ok: false, verdict: 'invalid', reason, ...(text ? { text } : {}) });

class Judge {
  readonly table: RefTable;
  readonly inverse = new Map<string, string>();
  names = new Map<string, string>();
  model: LModel;
  /** The layout as loaded: what "changed since the copy" is judged against (an earlier operation of the same answer is not a change by someone else). */
  private readonly base: LModel;
  constructor(model: LModel, private readonly snap: PtCopySnapshot, private readonly env: StageEnv) {
    this.model = model;
    this.base = model;
    this.table = tableOf(snap.refs);
    for (const [ref, bid] of Object.entries(snap.colors)) this.inverse.set(bid, ref);
  }

  private colorWords(bid: string): string { return this.env.colorName?.(bid) ?? this.inverse.get(bid) ?? bid; }

  /** The object a ref names: one the copy named, or one an earlier operation of the answer added. */
  find(ref: unknown): { node: LNode } | { error: string } {
    const key = normRef(ref);
    if (!key) return { error: 'The operation names no object.' };
    const added = this.names.get(key);
    if (added) { const f = findNode(this.model, added); return f ? { node: f.node } : { error: `"${key}" is no longer on the page.` }; }
    const entry = this.table.byRef.get(key);
    if (!entry) return { error: `"${key}" is not an object of the copied page.` };
    const hit = resolveRef(this.model, this.table, key);
    return hit ? { node: hit.node } : { error: `${key} (${entry.className} "${entry.name}") is no longer on this page.` };
  }

  /** A property that differs from what the copy showed: "changed since the copy: was 4, is 6". */
  stale(working: LNode, prop: PtProp): string | null {
    const node = findNode(this.base, working.id)?.node;
    if (!node) return null; // added by this answer
    const copied = this.snap.now[node.id];
    if (prop === 'name') {
      const was = this.table.byId.get(node.id)?.name;
      return was !== undefined && was !== node.name ? `changed since the copy: was "${was}", is "${node.name}"` : null;
    }
    if (!copied) return null;
    const colourOf = (bid: string): string | null => this.inverse.get(bid) ?? null;
    const is = nowOf(node, colourOf)[prop];
    const was = copied[prop];
    return JSON.stringify(was) === JSON.stringify(is) ? null : `changed since the copy: was ${show(was)}, is ${show(is)}`;
  }

  private rowShift(parent: LNode | null, before: LModel, after: LModel, moved: string): string | undefined {
    if (!parent) return undefined;
    const rowsOf = (m: LModel): Map<string, number> => {
      const p = findNode(m, parent.id)?.node;
      const out = new Map<string, number>();
      if (p) computeRows(p.children).forEach((r, i) => r.items.forEach(it => out.set(it.id, i)));
      return out;
    };
    const a = rowsOf(before), b = rowsOf(after);
    const shifted = [...b].filter(([id, row]) => id !== moved && a.has(id) && a.get(id) !== row).map(([id]) => findNode(after, id)?.node.name ?? id);
    if (!shifted.length) return undefined;
    const names = shifted.slice(0, 2).map(n => `"${n}"`).join(' and ');
    return `${names}${shifted.length > 2 ? ` and ${shifted.length - 2} more` : ''} ${shifted.length === 1 ? 'moves' : 'move'} to another row`;
  }

  // ── change ──
  change(op: PtOp): Outcome {
    const t = this.find(op.ref);
    if ('error' in t) return fail(t.error);
    const node = t.node;
    const prop = op.property?.trim();
    if (!prop) return fail('The change names no property.');
    const word = (PROP_WORDS as Record<string, string>)[prop] ?? prop;
    const text = `Change ${word} of ${typed(node)}`;
    if (!changeableProps(node).includes(prop as PtProp)) {
      const route = routeOf(node.className, prop);
      if (route) {
        const value = typeof op.value === 'string' ? op.value : '';
        if (!value.trim()) return fail(`The new ${route === 'code' ? 'code' : 'text'} of ${prop} is missing.`, text);
        // Not a layout edit: the editor or the object window shows it for the user to review and save.
        return { ok: false, verdict: 'open', text, route: { kind: route, id: node.id, className: node.className, name: node.name, property: prop, value } };
      }
      return fail(`"${prop}" is not something you may change on ${node.className}.`, text);
    }
    const p = prop as PtProp;
    const old = this.stale(node, p);
    if (old) return fail(old, text);
    const m = this.model;
    const parent = findNode(m, node.id)?.parent ?? null;
    const done = (model: LModel, value: string, warning?: string): Outcome => {
      const w = warning ?? this.rowShift(parent, m, model, node.id);
      return { ok: true, model, text: `${text} to ${value}`, ids: [node.id], ...(w ? { warning: w } : {}) };
    };
    const style = (patch: Partial<NodeStyle>, value: string, current: unknown, next: unknown): Outcome => {
      if (current === next) return fail(`No change: it already is ${value}.`, text);
      const model = setStyle(m, node.id, patch);
      const ghost = isFullGhost(findNode(model, node.id)!.node) && !isFullGhost(node);
      return done(model, value, ghost ? 'The object is hidden on every screen size' : undefined);
    };
    switch (p) {
      case 'name': {
        const v = typeof op.value === 'string' ? op.value.trim() : '';
        if (!v || v.length > 120) return fail('A name is 1 to 120 characters.', text);
        if (v === node.name) return fail(`No change: it already is "${v}".`, text);
        return done(rename(m, node.id, v), `"${v}"`);
      }
      case 'columns': case 'columnsMedium': case 'columnsSmall': {
        const n = int(op.value, 1, 6);
        if (n === null) return fail('Columns are a whole number from 1 to 6.', text);
        const bp = p === 'columns' ? 'L' : p === 'columnsMedium' ? 'M' : 'S';
        const current = bp === 'L' ? (node.cols.L === 0 ? 6 : node.cols.L) : node.cols[bp];
        if (current === n) return fail(`No change: it already is ${n}.`, text);
        return done(resize(m, node.id, bp, n), String(n));
      }
      case 'height': {
        const n = int(op.value, 20, 100000);
        if (!hasHeight(node.className) || n === null) return fail('Height is a whole number of pixels, 20 or more.', text);
        if (node.height === n) return fail(`No change: it already is ${n}.`, text);
        return done(setHeight(m, node.id, n), `${n} px`);
      }
      case 'headerColor': case 'fontColor': {
        const v = op.value;
        const clear = v === null || v === '' || (typeof v === 'string' && v.trim().toLowerCase() === 'none');
        const bid = clear ? '' : typeof v === 'string' ? this.snap.colors[normRef(v)] : undefined;
        if (bid === undefined) return fail(`${show(v)} is not one of the colors offered.`, text);
        const key = p === 'headerColor' ? 'headerColorBid' : 'fontColorBid';
        const current = node.style?.[key] ?? '';
        return style({ [key]: bid }, bid ? this.colorWords(bid) : 'none', current, bid);
      }
      case 'shadow': {
        const b = bool(op.value);
        if (b === null) return fail('Shadow is true or false.', text);
        return style({ shadow: b }, b ? 'on' : 'off', node.style?.shadow ?? false, b);
      }
      case 'headerStyle': case 'borderStyle': {
        const v = member(op.value, p);
        if (!v) return fail(`${p === 'headerStyle' ? 'Header bar' : 'Border'} is one of ${styleOptions(p).map(o => o.value).join(', ')}.`, text);
        const label = styleOptions(p).find(o => o.value === v)?.label ?? v;
        return style({ [p]: v }, label, node.style?.[p], v);
      }
      case 'transparency': {
        const n = int(op.value, 0, 100);
        if (n === null) return fail('Transparency is a whole number from 0 to 100.', text);
        return style({ transparency: n }, String(n), node.style?.transparency ?? 0, n);
      }
      case 'showToolMenu': case 'disableSearch': case 'shownOnLargeDisplay': case 'shownOnMediumDisplay': case 'shownOnSmallDisplay': {
        const b = bool(op.value);
        if (b === null) return fail(`${word} is true or false.`, text);
        const def = p === 'disableSearch' ? false : true;
        return style({ [p]: b }, b ? 'on' : 'off', node.style?.[p] ?? def, b);
      }
      case 'visibility': {
        const v = member(op.value, 'visibility');
        if (!v) return fail(`Visibility is one of ${styleOptions('visibility').map(o => o.value).join(', ')}.`, text);
        const label = styleOptions('visibility').find(o => o.value === v)?.label ?? v;
        return style({ visibility: v }, label, node.style?.visibility ?? 'VISIBLE', v);
      }
    }
  }

  // ── move ──
  private placeKey(op: PtOp): { key: 'before' | 'after' | 'into'; ref: string } | string {
    const raw: PtRawPlace | undefined = op.to ?? op.place;
    const keys = raw ? (['before', 'after', 'into'] as const).filter(k => raw[k]) : [];
    if (keys.length !== 1) return 'A place is exactly one of before, after or into, with an object.';
    return { key: keys[0], ref: raw![keys[0]]! };
  }

  move(op: PtOp): Outcome {
    const t = this.find(op.ref);
    if ('error' in t) return fail(t.error);
    const node = t.node;
    const text = `Move ${typed(node)}`;
    const pk = this.placeKey(op);
    if (typeof pk === 'string') return fail(pk, text);
    const a = this.find(pk.ref);
    if ('error' in a) return fail(a.error, text);
    const anchor = a.node;
    const m = this.model;
    const words = `${pk.key} ${anchor.kind === 'tab' ? 'tab ' : ''}"${anchor.name}"`;
    if (anchor.id === node.id) return fail('An object cannot be placed relative to itself.', text);
    if (isAncestorOf(node, anchor.id)) return fail('An object cannot be placed inside itself.', text);

    if (node.kind === 'tab') {
      if (anchor.kind !== 'tab' || pk.key === 'into') return fail('A tab is placed before or after another tab.', text);
      if (isResultTab(node) || isResultTab(anchor)) return fail('The Result tab stays where it is.', text);
      if ((node.tabsetId ?? m.tabsetId) !== (anchor.tabsetId ?? m.tabsetId)) return fail('Both tabs must be in the same tab set.', text);
      return { ok: true, model: insertRelative(m, node.id, anchor.id, pk.key === 'before'), text: `${text} ${words}`, ids: [node.id] };
    }
    const here = findNode(m, node.id)!;
    if (pk.key === 'into') {
      if (anchor.kind === 'widget') return fail('Only a tab or a container can hold an object.', text);
      const next = moveInto(m, node.id, anchor.id);
      const warning = isResultTab(anchor) && node.kind === 'container' ? 'The Result tab is shared by other pages' : this.rowShift(anchor, m, next, node.id);
      return { ok: true, model: next, text: `${text} ${words}`, ...(warning ? { warning } : {}), ids: [node.id] };
    }
    if (anchor.kind === 'tab') return fail('Place it into the tab, not beside it.', text);
    const af = findNode(m, anchor.id)!;
    const parent = af.parent;
    if (!parent) return fail('That place is not in the layout.', text);
    if (parent.kind === 'widget' && here.parent?.id !== parent.id) return fail(`"${parent.name}" holds its own members; place them in Blueprint.`, text);
    const kids = parent.children.filter(k => k.id !== node.id);
    const place = pk.key === 'before' ? { before: anchor.id } : { after: anchor.id };
    const idx = slotIndex(kids, place, node.kind);
    if (!legal(kids, idx, node.kind)) return fail(node.kind === 'container' ? BAND_CONTAINER : BAND_WIDGET, text);
    if (here.parent?.id === parent.id && here.index === idx) return fail('It is already there.', text);
    const next = insertRelative(m, node.id, anchor.id, pk.key === 'before');
    const warning = this.rowShift(parent, m, next, node.id);
    return { ok: true, model: next, text: `${text} ${words}`, ...(warning ? { warning } : {}), ids: [node.id] };
  }

  // ── add ──
  add(op: PtOp): Outcome {
    const type = op.type?.trim();
    if (!type) return fail('An add names no type.');
    const name = op.name === undefined ? undefined : op.name.trim();
    if (name !== undefined && (name.length < 1 || name.length > 120)) return fail('A name is 1 to 120 characters.', `Add ${type}`);
    if (op.as && (/^[tcok]\d+$/i.test(op.as) || this.names.has(op.as) || this.table.byRef.has(op.as))) return fail(`"${op.as}" is already a name; use another with "as".`, `Add ${type}`);
    const label = name ? `"${name}"` : '';
    const text = `Add ${type} ${label}`.trim();
    const m = this.model;
    const finish = (model: LModel, id: string, extra?: string): Outcome => {
      if (op.as) this.names.set(op.as, id);
      return { ok: true, model, text: extra ? `${text} ${extra}` : text, ids: [id], ...(op.as ? { as: { name: op.as, id } } : {}) };
    };

    if (type === 'Tab') {
      const pk = op.place ? this.placeKey(op) : null;
      if (typeof pk === 'string') return fail(pk, text);
      let anchor: LNode | undefined;
      if (pk) {
        const a = this.find(pk.ref);
        if ('error' in a) return fail(a.error, text);
        if (a.node.kind !== 'tab') return fail('A tab is added beside another tab.', text);
        if (pk.key === 'into') return fail('A tab is added before or after another tab.', text);
        if (isResultTab(a.node)) return fail('The Result tab stays where it is.', text);
        anchor = a.node;
      }
      if (m.resultOnly) {
        // The page has no tab set yet: the first tab makes one, named for the page, in the same apply.
        if (anchor) return fail('This page has no tabs to add to.', text);
        const res = createTabset(m, { tabName: name ?? 'New Tab', tabsetName: `${m.pageName ?? m.pageId} Tabs` });
        return finish(res.model, res.id, 'in a new tab set');
      }
      let tabsetId: string | undefined;
      if (anchor) tabsetId = anchor.tabsetId ?? m.tabsetId;
      else {
        const sets = editableTabsets(m);
        if (sets.length !== 1) return fail('Say which tab to add it after.', text);
        tabsetId = sets[0].id;
      }
      const res = addTab(m, tabsetId, name ?? 'New Tab');
      // addTab puts it at the end of its tab set; beside its anchor is where it was drawn.
      const model = anchor ? insertRelative(res.model, res.id, anchor.id, pk!.key === 'before') : res.model;
      return finish(model, res.id, anchor ? `${pk!.key} tab "${anchor.name}"` : '');
    }

    const kind = type === 'Container' ? 'container' : 'widget';
    if (kind === 'widget' && !isAddableWidget(type)) return fail(`${type} is not a type you may add. The types are: ${addTypes().slice(0, 6).join(', ')} ...`, text);
    const pk = this.placeKey(op);
    if (typeof pk === 'string') return fail(pk, text);
    const a = this.find(pk.ref);
    if ('error' in a) return fail(a.error, text);
    let parent: LNode, index: number, remapped = false;
    if (pk.key === 'into') {
      if (a.node.kind === 'widget') return fail('Only a tab or a container can hold a new object.', text);
      parent = a.node;
      index = bandInsertIndex(parent.children, undefined, kind).index;
    } else {
      if (a.node.kind === 'tab') return fail('Put it into the tab, not beside it.', text);
      const f = findNode(m, a.node.id)!;
      if (!f.parent || f.parent.kind === 'widget') return fail('That place holds its own members; add there in Blueprint.', text);
      parent = f.parent;
      const kids = parent.children;
      if (pk.key === 'after') {
        const r = bandInsertIndex(kids, a.node.id, kind);
        index = r.index; remapped = r.remapped;
      } else {
        const at = kids.findIndex(k => k.id === a.node.id);
        // The nearest place BMP can render, for a container and a widget alike, is the border between the two bands.
        if (legal(kids, at, kind)) index = at;
        else { index = kids.filter(k => k.kind === 'container').length; remapped = true; }
      }
    }
    // Properties a new object may be given.
    const props = op.properties ?? {};
    const allowed = new Set<PtProp>(kind === 'container' ? ['columns'] : newWidgetProps(type));
    let cols = 6;
    let height: number | undefined;
    const patch: Partial<NodeStyle> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!allowed.has(k as PtProp)) return fail(`"${k}" is not something a new ${type} may be given.`, text);
      if (k === 'columns') { const n = int(v, 1, 6); if (n === null) return fail('Columns are a whole number from 1 to 6.', text); cols = n; }
      else if (k === 'height') { const n = int(v, 20, 100000); if (n === null) return fail('Height is a whole number of pixels, 20 or more.', text); height = n; }
      else if (k === 'headerColor' || k === 'fontColor') {
        const clear = v === null || v === '' || (typeof v === 'string' && v.trim().toLowerCase() === 'none');
        const bid = clear ? '' : typeof v === 'string' ? this.snap.colors[normRef(v)] : undefined;
        if (bid === undefined) return fail(`${show(v)} is not one of the colors offered.`, text);
        patch[k === 'headerColor' ? 'headerColorBid' : 'fontColorBid'] = bid;
      } else if (k === 'shadow') { const b = bool(v); if (b === null) return fail('Shadow is true or false.', text); patch.shadow = b; }
      else if (k === 'headerStyle' || k === 'borderStyle') { const s = member(v, k); if (!s) return fail(`${k} is one of ${styleOptions(k).map(o => o.value).join(', ')}.`, text); patch[k] = s; }
      else if (k === 'transparency') { const n = int(v, 0, 100); if (n === null) return fail('Transparency is a whole number from 0 to 100.', text); patch.transparency = n; }
    }
    let model: LModel, id: string;
    if (kind === 'container') { const r = addContainer(m, parent.id, index, cols, name); model = r.model; id = r.id; }
    else {
      const r = addWidget(m, parent.id, index, type, name, cols); model = r.model; id = r.id;
      if (height !== undefined) model = setHeight(model, id, height);
      if (Object.keys(patch).length) model = setStyle(model, id, patch);
    }
    const where = `${pk.key} ${a.node.kind === 'tab' ? 'tab ' : ''}"${a.node.name}"`;
    const out = finish(model, id, remapped ? `into "${parent.name}"` : where);
    return remapped && out.ok ? { ...out, warning: 'That place is between containers, so it is added after the last container.' } : out;
  }

  // ── delete ──
  del(op: PtOp): Outcome {
    const t = this.find(op.ref);
    if ('error' in t) return fail(t.error);
    const node = t.node;
    const text = `Delete ${typed(node)}`;
    if (node.kind === 'tab') return fail('Tabs are deleted in Blueprint.', text);
    const warning = node.kind === 'container' && node.children.length ? 'Its widgets move to the tab.' : undefined;
    return { ok: true, model: remove(this.model, node.id), text, ids: [node.id], ...(warning ? { warning } : {}) };
  }
}

/**
 * The operations a drawn tab always has (Companion adds the tab itself: an answer's own add of it is dropped) and, for
 * marks the answer says nothing about, what the marks said on their own. Run before judging.
 */
export function withDraftOps(answer: PtAnswer, snap: PtCopySnapshot): PtAnswer {
  const drafts = snap.drafts ?? [];
  if (!drafts.length && !snap.direct?.length) return answer;
  const noteOf = (d: PtDraft): number => Number(d.id.slice(6));
  const tabNotes = new Set(drafts.map(noteOf));
  const refOfId = (id: string): string | undefined => snap.refs.find(r => r.id === id)?.ref ?? drafts.find(d => d.id === id)?.ref;
  const own: PtOp[] = drafts.map(d => {
    const a = d.anchor ? refOfId(d.anchor) : undefined;
    return { notes: [noteOf(d)], op: 'add', type: 'Tab', name: d.name, ...(a ? { place: { [d.before ? 'before' : 'after']: a } } : {}), as: d.ref };
  });
  const kept = answer.operations.filter(o => !(o.op === 'add' && o.type === 'Tab' && tabNotes.has(o.notes[0] ?? 0)));
  const said = new Set<number>([...kept.flatMap(o => o.notes), ...answer.questions.flatMap(q => q.notes), ...answer.cannot.flatMap(q => q.notes)]);
  const direct = (snap.direct ?? []).filter(o => !(o.op === 'add' && o.type === 'Tab') && !said.has(o.notes[0] ?? 0));
  return { ...answer, operations: [...own, ...direct, ...kept] };
}

/** Judge an answer against the page. `model` is the layout as Blueprint loaded it; the snapshot is what the AI was shown. */
export function stageAnswer(model: LModel, snapshot: PtCopySnapshot, given: PtAnswer, env: StageEnv = {}): PtStageResult {
  const answer = withDraftOps(given, snapshot);
  const judge = new Judge(model, snapshot, env);
  const known = new Map(snapshot.marks.map(m => [m.n, m.text]));
  const reports = new Map<number, PtNoteReport>();
  const report = (n: number): PtNoteReport => {
    let r = reports.get(n);
    if (!r) { r = { n, ...(known.has(n) ? { text: known.get(n) } : {}), results: [], questions: [], cannot: [], unaddressed: false }; reports.set(n, r); }
    return r;
  };
  for (const n of [...known.keys()].sort((a, b) => a - b)) report(n);

  const ops = answer.operations.map((op, i) => ({ op, i, note: op.notes[0] ?? 0 }))
    .sort((a, b) => (a.note - b.note) || (a.i - b.i)); // each note's operations together, notes in order
  const origins: Record<string, number> = {};
  const steps: PtStageResult['steps'] = [];
  let current = judge.model;
  let noteStart = current;
  let lastNote = -1;
  const closeNote = (n: number): void => { if (n >= 0 && judge.model !== noteStart) steps.push({ note: n, model: judge.model }); };
  let ready = 0, notPossible = 0, review = 0;
  let moveNote: number | undefined;

  for (const { op, note } of ops) {
    if (note !== lastNote) { closeNote(lastNote); lastNote = note; noteStart = judge.model; }
    const rep = report(note);
    let o: Outcome;
    if (note !== 0 && !known.has(note)) o = fail(`There is no note ${note}.`);
    else if (note === 0) o = fail('The operation names no note.');
    else if (op.op === 'change') o = judge.change(op);
    else if (op.op === 'move') o = judge.move(op);
    else if (op.op === 'add') o = judge.add(op);
    else if (op.op === 'delete') o = judge.del(op);
    else o = fail(`"${op.verb || 'This'}" is not an operation. Use change, move, add or delete.`);
    if (o.ok) {
      judge.model = o.model;
      current = o.model;
      ready++;
      if (op.op === 'move' && moveNote === undefined) moveNote = note;
      rep.results.push({ op, verdict: 'ok', text: o.text, ids: o.ids, ...(o.warning ? { warning: o.warning } : {}) });
    } else {
      if (o.verdict === 'open') review++; else notPossible++;
      rep.results.push({ op, verdict: o.verdict, text: o.text ?? opWords(op), ...(o.reason ? { reason: o.reason } : {}), ids: [], ...(o.route ? { route: o.route } : {}) });
    }
  }
  closeNote(lastNote);
  // A tab BMP shows only once it holds a widget: say so for a new tab that is left empty.
  for (const rep of reports.values()) {
    for (const r of rep.results) {
      if (r.verdict !== 'ok' || r.op.op !== 'add' || r.op.type !== 'Tab' || r.warning) continue;
      const tab = findNode(current, r.ids[0])?.node;
      if (tab && !descendantWidgets(tab).length) r.warning = 'BMP shows a tab once it holds a widget.';
    }
  }
  // Who asked for each row the tray will show: the first note whose cumulative changes bring that object into the plan.
  // (The compiler may express "move Export before New risk" as moving New risk, so the ops' own ids are not enough.)
  const seen = new Set<string>();
  for (const s of steps) {
    for (const st of diff(model, s.model)) { const id = planStepId(st); if (!seen.has(id)) { seen.add(id); origins[id] = s.note; } }
  }
  // Once all notes are in, the compiler may name another object for a move than it did along the way: that row is the move's.
  for (const st of diff(model, current)) {
    const id = planStepId(st);
    if (!(id in origins) && (st.kind === 'reorder' || st.kind === 'reparent') && moveNote !== undefined) origins[id] = moveNote;
  }

  for (const q of answer.questions) { const r = report(q.notes[0] ?? 0); r.questions.push(q.text); }
  for (const c of answer.cannot) { const r = report(c.notes[0] ?? 0); r.cannot.push(c.text); notPossible++; }
  for (const r of reports.values()) r.unaddressed = r.n !== 0 && !r.results.length && !r.questions.length && !r.cannot.length;
  const ordered = [...reports.values()].filter(r => r.n !== 0 || r.results.length || r.questions.length || r.cannot.length).sort((a, b) => (a.n || 1e9) - (b.n || 1e9));
  return { steps, reports: ordered, origins, final: current, ready, review, notPossible };
}

/** A line of words for an operation that could not be read well enough to describe. */
function opWords(op: PtOp): string {
  const v = op.op === 'unknown' ? op.verb || 'Unknown operation' : op.op[0].toUpperCase() + op.op.slice(1);
  return [v, op.type, op.ref, op.property].filter(Boolean).join(' ');
}
