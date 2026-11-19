/**
 * Point and tell: a page that does not exist yet. A shape drawn past the last breadcrumb (or the menu entry "New page
 * here") is a mark whose words are the page's name. Saving the name opens the PAPER PAGE: the real page is covered, not
 * changed; the breadcrumb gets a muted "/ New page", the title is the name, editable in place, and below it an empty
 * tab rule and six faint columns. Tabs and widgets are drawn there like on a drawn tab's paper, in a mark set of their
 * own (stored under `new:<viewed page>`). Closing it (a click on a crumb) keeps it; Clear discards it. Nothing is created
 * in BMP until the card says so (create-card.ts).
 */
import type { LModel } from '../lib/layout/types';
import { isPageMark } from '../lib/point-tell/drafts';
import { loadMarks, newPageKey, saveMarks } from '../lib/point-tell/store';
import type { PtMark } from '../lib/point-tell/types';
import { forgetGroup, resetHistory } from './ink-marks';
import { hooks, markByNumber, setMarks } from './marks';
import { pt } from './state';

export const NEW_PAGE_NAME = 'New page';

/** The model of a page with nothing on it yet: what BMP will hold right after the page is created. */
export function paperModel(name: string): LModel {
  return {
    pageId: 'draft:page', pageName: name, pageClass: 'Scorecard', tabsetId: 'draft:tabset', tabs: [], resultOnly: true,
    target: 'instance', hasTemplate: false,
  };
}

/** The page marks of the real page's set (the one on screen, or the one put aside while the paper page is open). */
export function pageMarks(): PtMark[] { return (pt.page ? pt.page.shelf.marks : pt.marks).filter(isPageMark); }

/** Open the paper page of the page mark `n`. */
export function enterPage(n: number): void {
  const m = markByNumber(n);
  if (pt.page || !m || !pt.model || !isPageMark(m)) return;
  const name = m.text.trim();
  if (!name) return;
  pt.editor = null; pt.fieldEl?.remove(); pt.fieldEl = null;
  pt.page = { n, name, shelf: { model: pt.model, ctx: pt.ctx, scope: pt.scope, links: pt.links, paper: pt.paper, marks: pt.marks, next: pt.next } };
  pt.model = paperModel(name);
  pt.ctx = null; pt.scope = 'instance'; pt.links = {}; pt.paper = null; pt.hover = null;
  const set = loadMarks(newPageKey(pt.rid));
  pt.marks = set.marks; pt.next = set.next;
  resetHistory(); forgetGroup();
  hooks.remeasure();
}

/** Back to the real page; the paper page is kept. */
export function leavePage(): void {
  const p = pt.page;
  if (!p) return;
  saveMarks(newPageKey(pt.rid), { marks: pt.marks, next: pt.next });
  pt.editor = null; pt.fieldEl?.remove(); pt.fieldEl = null;
  pt.card = null; pt.cardEl?.remove(); pt.cardEl = null;
  pt.model = p.shelf.model; pt.ctx = p.shelf.ctx; pt.scope = p.shelf.scope; pt.links = p.shelf.links; pt.paper = p.shelf.paper;
  pt.marks = p.shelf.marks; pt.next = p.shelf.next;
  pt.page = null; pt.hover = null;
  resetHistory(); forgetGroup();
  hooks.remeasure();
}

/** The name was changed in the title: the page, its model and the mark that drew it. */
export function renamePage(name: string): void {
  const p = pt.page;
  const next = name.trim();
  if (!p || !next || next === p.name || next.length > 120) return;
  p.name = next;
  pt.model = paperModel(next);
  p.shelf.marks = p.shelf.marks.map(m => (m.n === p.n ? { ...m, text: next } : m));
  saveMarks(pt.rid, { marks: p.shelf.marks, next: p.shelf.next });
  hooks.render();
}

/** Clear: the paper page and the mark that drew it are gone. */
export function discardPage(): void {
  const p = pt.page;
  if (!p) return;
  saveMarks(newPageKey(pt.rid), { marks: [], next: 1 });
  const keep = p.shelf.marks.filter(m => m.n !== p.n);
  leavePage();
  setMarks(keep, pt.next);
}

/** The page was created and the sketch moved to the new page: the real page's mark and the paper page's marks are gone from here. */
export function forgetPage(): void {
  const p = pt.page;
  if (!p) return;
  saveMarks(newPageKey(pt.rid), { marks: [], next: 1 });
  saveMarks(pt.rid, { marks: p.shelf.marks.filter(m => m.n !== p.n), next: p.shelf.next });
}
