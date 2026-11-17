/**
 * Object picker: choose one BMP object by name, ID or RID. Shared by code
 * search (scope, "Used in code" target) and Compare.
 *
 * Before any typing it offers the current object, the caller's own groups
 * (Compare: template and instances, siblings) and recently opened
 * objects. Typing searches through the caller's search (the Browse search);
 * a pasted RID or `ns.id` is offered as its own row and resolved by the
 * caller before it is picked. Keyboard: Up/Down move, Enter picks, Escape
 * cancels; the list is a listbox driven by aria-activedescendant. Pure DOM,
 * no chrome.*; styles are the `ui-picker` rules in src/styles/ui.css.
 */

import { unreadValue } from './failure-form';
import { typeLabel } from './object-window-table';

export interface PickerObject {
  /** 64-bit RID, always a string. */
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  /** Short context on the row (where it lives, when it was opened). */
  note?: string;
  /** Small tag after the note (`template`, `instance`). */
  tag?: string;
}

/** Offers before typing. `groups` come between the current object and the
 *  recent objects, in order. */
export interface PickerSuggestions {
  current?: PickerObject | null;
  groups?: ReadonlyArray<{ title: string; items: readonly PickerObject[] }>;
  recent: PickerObject[];
  /** Title of the recent group (default "Recent"). */
  recentTitle?: string;
}

/** Objects whose name, ID or RID match `query`. A source that answers in
 *  parts calls `partial` with the list so far; the list is shown at once.
 *  `coverage` says what the last finished search covered (shown under an
 *  empty result), or null. */
export interface PickerSearch {
  (query: string, signal: AbortSignal, partial?: (hits: PickerObject[]) => void): Promise<PickerObject[]>;
  coverage?(): string | null;
  /** A line shown under the results of the last finished search (a cut). */
  notice?(): string | null;
  /** Data objects are found by the portal's search: the picker says so
   *  under a finished search (DATA_OBJECTS_HINT). */
  dataHint?: boolean;
}

/** Where data objects (organisations, risks, action plans …) come from. */
export const DATA_OBJECTS_HINT = 'Data objects: found through the portal\'s search, or type the exact ID or paste a RID.';

export interface ObjectPickerSource {
  search: PickerSearch;
  /** A typed RID or `ns.id`: the object, or an error sentence. */
  resolve(text: string): Promise<PickerObject | { error: string }>;
  /** Offers before typing. */
  suggestions(): Promise<PickerSuggestions>;
}

export interface ObjectPickerOptions {
  source: ObjectPickerSource;
  /** Accessible name of the field. */
  label: string;
  placeholder?: string;
  onPick(obj: PickerObject): void;
  onCancel(): void;
  /** Label of a type for a row (the caller's type names). */
  typeLabel?(type: string): string;
  /** Order of search hits (Compare: same type first). */
  rankHit?(obj: PickerObject): number;
  debounceMs?: number;
}

export interface ObjectPicker {
  el: HTMLElement;
  focus(): void;
  /** Ask the source for its suggestions again. */
  refresh(): void;
  destroy(): void;
}

interface Row { key: string; obj?: PickerObject; text?: string; group: string }

/** A typed RID (5+ digits) or an ID with its space (`t.some_id`). */
export function typedReference(text: string): string | null {
  const t = text.trim();
  if (/^-?\d{5,20}$/.test(t)) return t;
  if (/^[a-z]{1,8}\.[A-Za-z0-9_-]{2,200}$/.test(t)) return t;
  return null;
}

/** Rows for the list: suggestions when empty, else the typed reference
 *  first, then search hits. Exported for tests. */
export function pickerRows(query: string, sugg: PickerSuggestions, hits: PickerObject[] | null, rank?: (obj: PickerObject) => number): Row[] {
  const rows: Row[] = [];
  const q = query.trim();
  if (!q) {
    const shown = new Set<string>();
    if (sugg.current) { rows.push({ key: `c:${sugg.current.rid}`, obj: sugg.current, group: 'Current object' }); shown.add(sugg.current.rid); }
    for (const g of sugg.groups ?? []) {
      for (const r of g.items) {
        if (shown.has(r.rid)) continue;
        shown.add(r.rid);
        rows.push({ key: `g:${r.rid}`, obj: r, group: g.title });
      }
    }
    for (const r of sugg.recent) if (!shown.has(r.rid)) { shown.add(r.rid); rows.push({ key: `r:${r.rid}`, obj: r, group: sugg.recentTitle ?? 'Recent' }); }
    return rows;
  }
  const typed = typedReference(q);
  if (typed) rows.push({ key: `t:${typed}`, text: typed, group: 'Typed' });
  const seen = new Set<string>();
  const ordered = rank ? [...(hits ?? [])].map((h, i) => ({ h, i, k: rank(h) })).sort((x, y) => x.k - y.k || x.i - y.i).map(x => x.h) : hits ?? [];
  for (const h of ordered) {
    if (seen.has(h.rid)) continue;
    seen.add(h.rid);
    rows.push({ key: `s:${h.rid}`, obj: h, group: 'Found' });
  }
  return rows;
}

let seq = 0;

export function createObjectPicker(o: ObjectPickerOptions): ObjectPicker {
  const id = `ui-picker-${++seq}`;
  const doc = document;
  const root = doc.createElement('div');
  root.className = 'ui-picker';
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'ui-input ui-picker-q';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = o.placeholder ?? 'Name, ID or RID';
  input.setAttribute('aria-label', o.label);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', `${id}-list`);
  input.setAttribute('aria-autocomplete', 'list');
  const list = doc.createElement('div');
  list.className = 'ui-picker-list';
  list.id = `${id}-list`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', o.label);
  const note = doc.createElement('div');
  note.className = 'ui-picker-note';
  note.setAttribute('role', 'status');
  root.append(input, list, note);

  let sugg: PickerSuggestions = { recent: [] };
  let hits: PickerObject[] | null = null;
  let rows: Row[] = [];
  let active = 0;
  let timer = 0;
  let controller: AbortController | null = null;
  let busy = false;
  let closed = false;
  /** What the last finished search covered. */
  let covered = '';
  /** The last search's line for its results (object-search notice). */
  let notice = '';
  /** When the search under way started, and the timer that shows its age. */
  let busySince = 0;
  let tickTimer = 0;
  const stopTick = () => { window.clearInterval(tickTimer); tickTimer = 0; };

  const label = (obj: PickerObject) => obj.name || obj.businessId || obj.rid;
  const render = () => {
    rows = pickerRows(input.value, sugg, hits, o.rankHit);
    if (active >= rows.length) active = Math.max(0, rows.length - 1);
    list.textContent = '';
    let group = '';
    rows.forEach((r, i) => {
      if (r.group !== group && r.group !== 'Typed') {
        group = r.group;
        const h = doc.createElement('div');
        h.className = 'ui-picker-group';
        h.textContent = r.group;
        h.setAttribute('role', 'presentation');
        list.append(h);
      }
      const opt = doc.createElement('div');
      opt.className = `ui-picker-opt${i === active ? ' on' : ''}`;
      opt.id = `${id}-o${i}`;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', String(i === active));
      if (r.obj) {
        const nm = doc.createElement('span');
        nm.className = 'nm';
        nm.textContent = label(r.obj);
        opt.append(nm);
        // Only a RID came back: its name and type could not be read. Say so quietly instead of
        // showing the RID as if it were a name (the RID stays as the row's ID).
        if (!r.obj.name && !r.obj.businessId && !r.obj.type && !r.obj.note) {
          nm.replaceChildren(unreadValue('Its name and type could not be read; the RID is all that is known.'));
          const rid = doc.createElement('span');
          rid.className = 'ui-id';
          rid.textContent = r.obj.rid;
          opt.append(rid);
        }
        if (r.obj.businessId) {
          const bid = doc.createElement('span');
          bid.className = 'ui-id';
          bid.textContent = r.obj.businessId;
          opt.append(bid);
        }
        const ty = doc.createElement('span');
        ty.className = 'ty';
        ty.textContent = r.obj.note ?? (r.obj.type ? (o.typeLabel?.(r.obj.type) ?? typeLabel(r.obj.type)) : '');
        if (r.obj.tag) {
          const tag = doc.createElement('span');
          tag.className = 'ui-picker-tag';
          tag.textContent = r.obj.tag;
          ty.append(tag);
        }
        opt.append(ty);
      } else {
        const nm = doc.createElement('span');
        nm.className = 'nm';
        nm.textContent = `Use ${r.text}`;
        opt.append(nm);
      }
      opt.addEventListener('mousedown', e => e.preventDefault());
      opt.addEventListener('click', () => { active = i; void pick(); });
      list.append(opt);
    });
    if (rows[active]) input.setAttribute('aria-activedescendant', `${id}-o${active}`);
    else input.removeAttribute('aria-activedescendant');
    if (!note.dataset.error) {
      // After 3 s the note says how long it has been and how to stop it.
      const secs = busy ? Math.floor((Date.now() - busySince) / 1000) : 0;
      const age = secs >= 3 ? ` ${secs} s · Esc stops it` : '';
      note.textContent = busy ? (hits?.length ? `Searching the server for more…${age}` : `Searching…${age}`) : input.value.trim() && hits && !rows.length ? `Nothing found by name, ID or RID.${covered ? ` ${covered}` : ''}` : input.value.trim() && hits ? notice : '';
    }
    if (!note.dataset.error && !busy && o.source.search.dataHint && hits && input.value.trim()) {
      const hint = doc.createElement('span');
      hint.className = 'ui-picker-hint';
      hint.textContent = DATA_OBJECTS_HINT;
      note.append(note.textContent ? ' ' : '', hint);
    }
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const setError = (text: string) => {
    if (text) note.dataset.error = '1'; else delete note.dataset.error;
    note.textContent = text;
    note.classList.toggle('err', !!text);
  };

  const pick = async () => {
    const r = rows[active];
    if (!r) return;
    if (r.obj) { closed = true; o.onPick(r.obj); return; }
    if (!r.text) return;
    setError('');
    busy = true;
    render();
    const res = await o.source.resolve(r.text).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    busy = false;
    if (closed) return;
    if ('error' in res) { setError(res.error); render(); return; }
    closed = true;
    o.onPick(res);
  };

  const runSearch = () => {
    controller?.abort();
    const q = input.value.trim();
    if (!q) { hits = null; busy = false; render(); return; }
    const c = new AbortController();
    notice = '';
    controller = c;
    busy = true;
    busySince = Date.now();
    stopTick();
    tickTimer = window.setInterval(() => { if (busy && !closed) render(); else stopTick(); }, 1000);
    render();
    o.source.search(q, c.signal, part => {
      if (c.signal.aborted || closed) return;
      hits = part;
      render();
    }).then(found => {
      if (c.signal.aborted || closed) return;
      hits = found;
      busy = false;
      covered = o.source.search.coverage?.() ?? '';
      notice = o.source.search.notice?.() ?? '';
      render();
    }, (e: unknown) => {
      if (c.signal.aborted || closed) return;
      // What was found before the failure stays.
      hits = hits ?? [];
      busy = false;
      setError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
      render();
    });
  };

  input.addEventListener('input', () => {
    setError('');
    active = 0;
    hits = null;
    covered = '';
    render();
    window.clearTimeout(timer);
    timer = window.setTimeout(runSearch, o.debounceMs ?? 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length) active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      // A pasted reference that was not searched yet is still offered.
      if (!rows.length) rows = pickerRows(input.value, sugg, hits, o.rankHit);
      void pick();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      // A search under way stops first (what was found stays); then the picker closes.
      if (busy && controller) {
        controller.abort();
        busy = false;
        stopTick();
        notice = 'Stopped.';
        render();
        return;
      }
      closed = true;
      stopTick();
      o.onCancel();
    }
  });

  const loadSuggestions = () => { void o.source.suggestions().then(s => { sugg = s; if (!closed) render(); }, () => { /* no suggestions */ }); };
  loadSuggestions();
  render();
  return {
    el: root,
    focus: () => input.focus(),
    refresh: loadSuggestions,
    destroy: () => { closed = true; controller?.abort(); window.clearTimeout(timer); stopTick(); root.remove(); },
  };
}
