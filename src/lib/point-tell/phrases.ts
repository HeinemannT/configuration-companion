/**
 * Point and tell: what a mark is called when it is copied for an AI. Every mark has three parts of different
 * reliability, as plain phrases over the copy's refs:
 *
 *   drew   what is physically on the page (a fact): "circle around o3, o4", "arrow from o7 ending just after o5"
 *   guess  what Companion thinks that means (a guess, absent when it is unsure or has no reading): "move o7 after o5"
 *   says   the user's own words (the caller adds them, unchanged)
 *
 * One function per kind of mark. Pure: refs in, text out. No confidence scores, no ids, no coordinates.
 */
import type { PtDraft, PtGridPlace, PtMark, PtPlace, PtRawPlace, PtWidgetKind } from './types';
import { isDraftId } from './drafts';
import type { RefTable } from './refs';

export type MarkKind = 'note' | 'click' | 'circle' | 'pointer' | 'ink' | 'arrow' | 'pair' | 'cross' | 'underline' | 'square' | 'tab' | 'page';

export interface PhraseCtx {
  refs: RefTable;
  /** The ref of the tab BMP shows; places on it need no "on t1". */
  shownTab?: string;
}

/** Which kind of mark this is, from what the page stored of it. */
export function kindOf(m: PtMark): MarkKind {
  const mean = m.meaning;
  if (mean?.kind === 'add') return mean.page ? 'page' : mean.tab ? 'tab' : 'square';
  if (mean?.kind === 'move') return mean.columns !== undefined ? 'pair' : 'arrow';
  if (mean?.kind === 'crossed') return 'cross';
  if (mean?.kind === 'change') return 'underline';
  if (m.ink) return m.reading && m.targets.length ? (m.pointer ? 'pointer' : 'circle') : 'ink';
  return m.targets.length ? 'click' : 'note';
}

const refOf = (c: PhraseCtx, id: string | undefined): string | undefined => (id ? c.refs.byId.get(id)?.ref : undefined);
const refsOf = (c: PhraseCtx, ids: readonly string[]): string[] => ids.flatMap(id => refOf(c, id) ?? []);

/** A place as the answer writes it (one ref), or null when its object is not in the copy. */
export function rawPlace(c: PhraseCtx, p: PtPlace): PtRawPlace | null {
  const key = 'before' in p ? 'before' : 'after' in p ? 'after' : 'into';
  const ref = refOf(c, (p as Record<string, string>)[key]);
  return ref ? { [key]: ref } : null;
}

/** "after o5", "before o4", "into c2". */
const placeText = (p: PtRawPlace): string => (p.before ? `before ${p.before}` : p.after ? `after ${p.after}` : `into ${p.into}`);

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "row 2, columns 5-6" / "row 2, column 5" / "row 2" / "". */
export function gridWords(g: PtGridPlace): string {
  if (!g.row) return '';
  if (!g.col) return `row ${g.row}`;
  const end = Math.min(6, g.col + Math.max(1, g.cols ?? 1) - 1);
  return `row ${g.row}, ${end > g.col ? `columns ${g.col}-${end}` : `column ${g.col}`}`;
}

/** Where on the page: "on n1 in c2 at row 2, columns 5-6". The shown tab is not named. */
export function whereWords(g: PtGridPlace, c: PhraseCtx): string {
  const tab = refOf(c, g.tabId);
  const parts: string[] = [];
  if (g.tabId && isDraftId(g.tabId) && !tab) parts.push('on the new page');
  else if (tab && tab !== c.shownTab) parts.push(`on ${tab}`);
  const box = refOf(c, g.containerId);
  if (box) parts.push(`in ${box}`);
  const grid = gridWords(g);
  if (grid) parts.push(`at ${grid}`);
  return parts.join(' ');
}

const INSIDE: Record<PtWidgetKind, string> = { table: 'lines inside', chart: 'bars inside', button: 'a small rounded box', text: 'wavy lines inside' };

// ── drew: one function per kind ─────────────────────────────────────────────────────────────────

function drewClick(m: PtMark, c: PhraseCtx): string | undefined {
  const r = refsOf(c, m.targets);
  return r.length ? `click on ${r.join(', ')}` : undefined;
}
function drewCircle(m: PtMark, c: PhraseCtx): string | undefined {
  const r = refsOf(c, m.targets);
  return r.length ? `circle around ${r.join(', ')}` : undefined;
}
function drewPointer(m: PtMark, c: PhraseCtx): string | undefined {
  const r = refsOf(c, m.targets);
  return r.length ? `arrow pointing at ${r.join(', ')}` : undefined;
}
function drewArrow(m: PtMark, c: PhraseCtx): string | undefined {
  const from = refOf(c, m.targets[0]);
  const to = m.meaning?.kind === 'move' ? rawPlace(c, m.meaning.to) : null;
  if (!from) return undefined;
  const end = to ? (to.before ? `just before ${to.before}` : to.after ? `just after ${to.after}` : `inside ${to.into}`) : 'elsewhere';
  return `arrow from ${from} ending ${end}`;
}
function drewPair(m: PtMark, c: PhraseCtx): string | undefined {
  const from = refOf(c, m.targets[0]);
  if (!from) return undefined;
  const where = m.ink ? whereWords(m.ink.place, c) : '';
  return `arrow from ${from} into a square${where ? ` ${where}` : ''}`;
}
function drewCross(m: PtMark, c: PhraseCtx): string | undefined {
  const r = refsOf(c, m.targets);
  return r.length ? `cross over ${r.join(', ')}` : undefined;
}
function drewUnderline(m: PtMark, c: PhraseCtx): string | undefined {
  const r = refsOf(c, m.targets);
  return r.length ? `underline under ${r.join(', ')}` : undefined;
}
function drewSquare(m: PtMark, c: PhraseCtx): string | undefined {
  const mean = m.meaning?.kind === 'add' ? m.meaning : null;
  const where = m.ink ? whereWords(m.ink.place, c) : '';
  const inside = mean?.widget ? `, ${INSIDE[mean.widget]}` : '';
  return `square${where ? ` ${where}` : ''}${inside}`;
}
function drewTab(m: PtMark, c: PhraseCtx): string {
  const p = m.meaning?.kind === 'add' ? rawPlace(c, m.meaning.place) : null;
  if (p?.after) return `tab shape after ${p.after} on the tab row`;
  if (p?.before) return `tab shape before ${p.before} on the tab row`;
  return 'tab shape on the tab row';
}
function drewPage(): string { return 'shape past the last breadcrumb'; }
function drewInk(m: PtMark, c: PhraseCtx): string {
  const r = refsOf(c, m.targets);
  if (r.length) return `ink near ${r.join(', ')}`;
  const where = m.ink ? whereWords(m.ink.place, c) : '';
  return where ? `ink ${where}` : 'ink on the page';
}

/** What is on the page for this mark; undefined for a note about the page. */
export function drewOf(m: PtMark, c: PhraseCtx): string | undefined {
  switch (kindOf(m)) {
    case 'click': return drewClick(m, c);
    case 'circle': return drewCircle(m, c);
    case 'pointer': return drewPointer(m, c);
    case 'arrow': return drewArrow(m, c);
    case 'pair': return drewPair(m, c);
    case 'cross': return drewCross(m, c);
    case 'underline': return drewUnderline(m, c);
    case 'square': return drewSquare(m, c);
    case 'tab': return drewTab(m, c);
    case 'page': return drewPage();
    case 'ink': return drewInk(m, c);
    default: return undefined;
  }
}

// ── guess: only where Companion has a reading ───────────────────────────────────────────────────

const WIDGET_NOUN: Record<PtWidgetKind, string> = { table: 'a table', chart: 'a chart', button: 'a button', text: 'text' };
const wide = (columns: number | undefined): string => (columns ? `, ${plural(columns, 'column')} wide` : '');

function guessMove(m: PtMark, c: PhraseCtx): string | undefined {
  if (m.meaning?.kind !== 'move') return undefined;
  const who = refOf(c, m.targets[0]);
  const to = rawPlace(c, m.meaning.to);
  if (!who || !to) return undefined;
  return `move ${who} ${placeText(to)}${wide(m.meaning.columns)}`;
}
function guessAdd(m: PtMark, c: PhraseCtx): string | undefined {
  if (m.meaning?.kind !== 'add') return undefined;
  const to = rawPlace(c, m.meaning.place);
  return `add ${m.meaning.widget ? WIDGET_NOUN[m.meaning.widget] : 'a widget'}${wide(m.meaning.columns)}${to ? `, ${placeText(to)}` : ''}`;
}
function guessTab(m: PtMark, c: PhraseCtx, draft: PtDraft | undefined): string {
  const to = m.meaning?.kind === 'add' ? rawPlace(c, m.meaning.place) : null;
  return `add a tab${to ? ` ${placeText(to)}` : ''}${draft ? `, as ${draft.ref}` : ''}`;
}

/** What Companion thinks the mark means; undefined when it has no reading (a circle, a cross, ink, a click, a note). */
export function guessOf(m: PtMark, c: PhraseCtx, draft?: PtDraft): string | undefined {
  switch (kindOf(m)) {
    case 'arrow': case 'pair': return guessMove(m, c);
    case 'square': return guessAdd(m, c);
    case 'tab': return guessTab(m, c, draft);
    default: return undefined;
  }
}
