/**
 * "Test as" combobox model — no DOM. Filtering is local over an index built
 * once per subject list; the view renders only a window of the matches and
 * says so ("Showing 100 of 214") instead of cutting the list silently.
 */

import type { AccessSubject } from '../../lib/types';

export type SubjectKind = 'all' | 'user' | 'role';

export interface SubjectIndex {
  list: readonly AccessSubject[];
  /** Lower-case "name businessId" per subject. */
  hay: readonly string[];
  byRid: ReadonlyMap<string, AccessSubject>;
}

export function indexSubjects(list: readonly AccessSubject[]): SubjectIndex {
  return {
    list,
    hay: list.map(s => `${s.name} ${s.businessId ?? ''}`.toLowerCase()),
    byRid: new Map(list.map(s => [s.rid, s])),
  };
}

export interface SubjectMatches {
  /** Recently tested subjects that match, most recent first. */
  recent: AccessSubject[];
  rest: AccessSubject[];
  /** Matches before the window was applied. */
  total: number;
  shown: number;
}

/** Default number of options rendered at once. */
export const SUBJECT_WINDOW = 100;

export function matchSubjects(index: SubjectIndex, query: string, kind: SubjectKind, recents: readonly string[], limit = SUBJECT_WINDOW): SubjectMatches {
  const q = query.trim().toLowerCase();
  const prefix: AccessSubject[] = [];
  const inner: AccessSubject[] = [];
  index.list.forEach((s, i) => {
    if (kind !== 'all' && s.kind !== kind) return;
    if (!q) { prefix.push(s); return; }
    const h = index.hay[i];
    const at = h.indexOf(q);
    if (at < 0) return;
    // A match at the start of the name or of the business ID ranks first.
    const bidAt = s.name.length + 1;
    (at === 0 || at === bidAt || h[at - 1] === ' ' || h[at - 1] === '_' ? prefix : inner).push(s);
  });
  const pool = [...prefix, ...inner];
  const inPool = new Set(pool.map(s => s.rid));
  const recentSet = new Set(recents);
  const recent = recents.map(r => index.byRid.get(r)).filter((s): s is AccessSubject => !!s && inPool.has(s.rid));
  const rest = pool.filter(s => !recentSet.has(s.rid));
  const total = pool.length;
  const r = recent.slice(0, limit);
  const rr = rest.slice(0, Math.max(0, limit - r.length));
  return { recent: r, rest: rr, total, shown: r.length + rr.length };
}

export interface ComboState {
  open: boolean;
  /** Index of the active option in the rendered order (recent, then rest). */
  active: number;
}

export interface ComboStep {
  state: ComboState;
  /** Option index to pick. */
  pick?: number;
  /** Close and put the chosen subject's name back into the input. */
  restore?: boolean;
  /** The key was used (the caller prevents the default). */
  handled: boolean;
}

/** Keyboard model of the combobox (WAI-ARIA combobox with listbox popup). */
export function comboKey(state: ComboState, key: string, count: number): ComboStep {
  const last = Math.max(0, count - 1);
  switch (key) {
    case 'ArrowDown':
      if (!state.open) return { state: { open: true, active: Math.min(state.active, last) }, handled: true };
      return { state: { open: true, active: Math.min(last, state.active + 1) }, handled: true };
    case 'ArrowUp':
      if (!state.open) return { state: { open: true, active: Math.min(state.active, last) }, handled: true };
      return { state: { open: true, active: Math.max(0, state.active - 1) }, handled: true };
    case 'Home':
      return state.open ? { state: { open: true, active: 0 }, handled: true } : { state, handled: false };
    case 'End':
      return state.open ? { state: { open: true, active: last }, handled: true } : { state, handled: false };
    case 'PageDown':
      return state.open ? { state: { open: true, active: Math.min(last, state.active + 8) }, handled: true } : { state, handled: false };
    case 'PageUp':
      return state.open ? { state: { open: true, active: Math.max(0, state.active - 8) }, handled: true } : { state, handled: false };
    case 'Enter':
      if (state.open && count > 0) return { state: { open: false, active: state.active }, pick: Math.min(state.active, last), handled: true };
      return { state, handled: false };
    case 'Escape':
      return { state: { open: false, active: state.active }, restore: true, handled: state.open };
    case 'Tab':
      return { state: { open: false, active: state.active }, restore: state.open, handled: false };
    default:
      return { state, handled: false };
  }
}
