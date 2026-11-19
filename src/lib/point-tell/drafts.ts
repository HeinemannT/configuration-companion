/**
 * Point and tell: tabs the user drew. A tab drawn on the tab row is a mark whose meaning is an add with `tab`,
 * placed beside another tab; its words are the tab's name. BMP does not have it yet, so it lives here as a
 * DRAFT with a temporary id (`draft:<mark number>`) and, in a copy, a ref in the "as" namespace (n1, n2 ...).
 * Everything here is pure and never changes what it is given.
 */
import { findNode } from '../layout/model';
import type { LModel, LNode } from '../layout/types';
import type { PtDraft, PtMark } from './types';

export const DRAFT_PREFIX = 'draft:';
export const isDraftId = (id: string | undefined): boolean => !!id && id.startsWith(DRAFT_PREFIX);
export const draftIdOf = (n: number): string => `${DRAFT_PREFIX}${n}`;
export const NEW_TAB_NAME = 'New tab';

/** A mark that drew a tab. */
export const isTabMark = (m: Pick<PtMark, 'meaning'>): boolean => m.meaning?.kind === 'add' && m.meaning.tab === true;
/** A mark that drew a page. */
export const isPageMark = (m: Pick<PtMark, 'meaning'>): boolean => m.meaning?.kind === 'add' && m.meaning.page === true;

/** The tabs drawn, in the order of their marks, each with its ref (n1, n2 ...). */
export function draftTabs(marks: readonly PtMark[]): PtDraft[] {
  const out: PtDraft[] = [];
  for (const m of marks) {
    if (!isTabMark(m) || m.meaning?.kind !== 'add') continue;
    const p = m.meaning.place;
    const before = 'before' in p;
    const anchor = 'before' in p ? p.before : 'after' in p ? p.after : undefined;
    out.push({ ref: `n${out.length + 1}`, id: draftIdOf(m.n), name: m.text.trim() || NEW_TAB_NAME, ...(anchor ? { anchor } : {}), ...(before ? { before: true } : {}) });
  }
  return out;
}

/** The model with the drawn tabs in it, each beside its anchor, in the anchor's tab set. The model given is not changed. */
export function withDrafts(base: LModel, drafts: readonly PtDraft[]): LModel {
  if (!drafts.length) return base;
  const tabs = base.tabs.slice();
  for (const d of drafts) {
    const at = d.anchor ? tabs.findIndex(t => t.id === d.anchor) : -1;
    const anchorTab = at >= 0 ? tabs[at] : undefined;
    const node: LNode = { id: d.id, kind: 'tab', className: 'Tab', name: d.name, tabsetId: anchorTab?.tabsetId ?? base.tabsetId, cols: { L: 6 }, children: [] };
    if (at < 0) tabs.push(node); else tabs.splice(d.before ? at : at + 1, 0, node);
  }
  return { ...base, tabs };
}

/** The tab set a draft goes into (its anchor's, else the page's). */
export function draftTabset(base: LModel, d: PtDraft): string | undefined {
  const a = d.anchor ? findNode(base, d.anchor)?.node : undefined;
  return a?.tabsetId ?? base.tabsetId;
}
