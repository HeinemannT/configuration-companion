/**
 * Point and tell: the paper. Two things are drawn on it.
 *
 * A DRAWN TAB with a name becomes the shown tab: its name is written inside the stroke that drew it, the real tabs
 * sit under a light veil, and the content area is an empty sheet with six faint columns where its widgets are
 * sketched. Clicking a real tab drops the paper and BMP switches as always.
 *
 * A DRAWN PAGE (page-draft.ts) opens a whole paper page under the breadcrumb: a white sheet with the page's name as
 * its title, a tab rule and the same six columns.
 *
 * Nothing is inserted into BMP's own tab strip or page: everything here is a child of the Point and tell layer, so no
 * query over the page's tabs can find it (and nothing carries role="tab"). Positions and stacking are inline.
 */
import { draftIdOf, draftTabs, isDraftId, isPageMark, isTabMark, withDrafts } from '../lib/point-tell/drafts';
import { unionOf, type PtTarget, type Rect } from '../lib/point-tell/hit';
import type { LModel } from '../lib/layout/types';
import type { PtScene } from '../lib/point-tell/resolve';
import type { PtMark } from '../lib/point-tell/types';
import { markBox } from './ink-marks';
import { measureCrumbRow } from './measure';
import { renamePage } from './page-draft';
import { pt } from './state';
import { Z, placed } from './view';

const PAPER_GAP = 16;
const PAD = 10;
/** How far the paper reaches past the columns on each side. */
const SIDE = 48;
const LABEL_FONT = "600 13px 'BPInter',system-ui,sans-serif";
const TITLE_H = 44;
const ROW_H = 40;
const NEW_PAGE_LABEL = 'New page';

interface Drawn { id: string; mark: PtMark; box: Rect }

/** The marks that drew a tab or a page, with the box of the stroke (or, with no stroke, a box at the end of the breadcrumb). */
function drawn(pick: (m: PtMark) => boolean): Drawn[] {
  const out: Drawn[] = [];
  for (const m of pt.marks) {
    if (!pick(m)) continue;
    let box = markBox(m);
    if (!box && isPageMark(m)) {
      const c = pt.model ? measureCrumbRow(pt.model) : undefined;
      if (c) box = { left: c.rect.left + 8, top: c.rect.top, width: 110, height: c.rect.height };
    }
    if (box) out.push({ id: draftIdOf(m.n), mark: m, box });
  }
  return out;
}
const drawnTabs = (): Drawn[] => drawn(isTabMark);
const drawnPages = (): Drawn[] => (pt.page ? [] : drawn(isPageMark));

/** The drawn tabs as pills of the scene: they count as tabs when later strokes are read. */
export function draftPills(): PtTarget[] {
  return drawnTabs().map(d => ({ id: d.id, kind: 'tab' as const, rect: d.box }));
}

/** The page mark under a point (real page only): a click on its label opens the paper page. */
export function pageMarkAt(x: number, y: number): number | null {
  const hit = drawnPages().find(d => d.mark.text.trim() && x >= d.box.left && x <= d.box.left + d.box.width && y >= d.box.top && y <= d.box.top + d.box.height);
  return hit ? hit.mark.n : null;
}

/** The model with the drawn tabs in it (the scene's model). */
export function modelWithDrafts(model: LModel): LModel { return withDrafts(model, draftTabs(pt.marks)); }

/** Where the paper page lies: under the breadcrumb, as wide as BMP's content. */
export function pageGeometry(): { left: number; width: number; sheetTop: number; titleTop: number; rowTop: number } {
  const crumbs = document.querySelector('.corpo-breadcrumbs__root, nav.page-location');
  const r = crumbs?.getBoundingClientRect();
  const left = 24;
  const sheetTop = r ? Math.round(r.bottom + window.scrollY) + 6 : 82;
  const titleTop = sheetTop + 14;
  return { left, width: Math.max(300, document.documentElement.clientWidth - 2 * left), sheetTop, titleTop, rowTop: titleTop + TITLE_H + 8 };
}

/** The scene of the paper page: no objects, the drawn tabs as pills, a tab row of its own. */
export function pageScene(model: LModel): PtScene {
  const g = pageGeometry();
  return { model: modelWithDrafts(model), liveTabId: pt.paper, targets: [], pills: draftPills(), paperPage: true, tabRow: { rect: { left: g.left, top: g.rowTop, width: g.width, height: ROW_H } } };
}

/** The area of the paper: under the tab row, as wide as the page's content. */
function paperRect(): Rect | null {
  const row = pt.scene?.tabRow?.rect;
  if (!row) return null;
  const top = row.top + row.height + PAPER_GAP;
  const height = Math.max(window.innerHeight, document.body.scrollHeight) - top;
  return height > 40 ? { left: row.left, top, width: row.width, height } : null;
}

/** Make the scene show the paper (or not): the drawn tab is the shown tab and the real widgets are under the sheet. */
export function applyPaper(): void {
  const s = pt.scene;
  if (!s) return;
  if (pt.paper && !drawnTabs().some(d => d.id === pt.paper)) pt.paper = null;
  const rect = pt.paper ? paperRect() : null;
  if (!pt.paper || !rect) { delete s.paper; return; }
  s.paper = { tabId: pt.paper, rect };
  s.liveTabId = pt.paper;
  s.targets = [];
}

/** Show the paper of a drawn tab (null: back to BMP's own tab). */
export function showPaper(id: string | null): void { pt.paper = id && isDraftId(id) ? id : null; }

const make = (tag: 'div' | 'span' | 'input', cls: string, t?: string): HTMLElement => { const e = document.createElement(tag); e.className = cls; if (t) e.textContent = t; return e; };

function columns(r: Rect, z: string): HTMLElement {
  const paper = placed(make('div', 'pt-paper'), 'absolute', z);
  // The sheet reaches well past the columns on both sides (BMP's cards sit in the page's side padding and cast shadows there), so nothing of the real page shows at its edges.
  const doc = document.documentElement.clientWidth;
  const left = Math.max(0, r.left - SIDE), right = Math.min(doc, r.left + r.width + SIDE);
  paper.style.left = `${left}px`; paper.style.top = `${r.top - PAD}px`; paper.style.width = `${right - left}px`; paper.style.height = `${r.height + PAD}px`;
  paper.style.padding = `${PAD}px ${right - (r.left + r.width)}px 0 ${r.left - left}px`; paper.style.boxSizing = 'border-box';
  paper.style.pointerEvents = 'none'; paper.style.background = '#fff';
  paper.style.display = 'grid'; paper.style.gridTemplateColumns = 'repeat(6, 1fr)'; paper.style.gap = '16px';
  for (let i = 0; i < 6; i++) paper.appendChild(make('div', 'pt-paper-col'));
  return paper;
}

function label(box: Rect, text: string, cls: string): HTMLElement {
  const el = placed(make('div', cls, text), 'absolute', Z.label);
  // A tab drawn into a narrow gap is narrower than its name: the label grows to fit and, over a real tab's name, is solid.
  const need = Math.ceil(text.length * 7.4) + 24;
  const w = Math.max(box.width, need);
  const left = box.left - (w - box.width) / 2;
  const over = (pt.scene?.pills ?? []).some(p => !isDraftId(p.id) && p.rect.left < left + w && left < p.rect.left + p.rect.width);
  if (over) el.style.background = '#fff';
  el.style.left = `${left}px`; el.style.top = `${box.top}px`; el.style.width = `${w}px`; el.style.height = `${box.height}px`;
  el.style.pointerEvents = 'none'; el.style.font = LABEL_FONT;
  return el;
}

/** The title of the paper page: the name, editable in place. Above the pointer surface, so a click lands in it. */
function titleField(g: ReturnType<typeof pageGeometry>): HTMLElement {
  const input = placed(make('input', 'pt-page-title'), 'absolute', Z.field) as HTMLInputElement;
  input.type = 'text'; input.value = pt.page?.name ?? ''; input.maxLength = 120; input.spellcheck = false;
  input.setAttribute('aria-label', 'Page name');
  input.style.left = `${g.left - 6}px`; input.style.top = `${g.titleTop}px`; input.style.width = `${Math.min(640, g.width)}px`; input.style.height = `${TITLE_H}px`;
  input.style.pointerEvents = 'auto';
  for (const type of ['keydown', 'keyup', 'keypress'] as const) input.addEventListener(type, (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  input.addEventListener('blur', () => { if (input.value.trim()) renamePage(input.value); else input.value = pt.page?.name ?? ''; });
  return input;
}

/** Draw the labels, the veil and the paper. Rebuilt on every render: a handful of elements, none at rest without a drawn tab or page. */
export function renderPaper(): void {
  const layer = pt.layer;
  if (!layer) return;
  // The title field keeps what is being typed while the rest is drawn again.
  const title = pt.paperEl?.querySelector<HTMLInputElement>('.pt-page-title');
  const typing = title && document.activeElement === title ? title.value : null;
  pt.paperEl?.remove();
  pt.paperEl = null;
  const tabs = drawnTabs(), pages = drawnPages();
  if (!tabs.length && !pages.length && !pt.page) return;
  const wrap = placed(make('div', 'pt-paper-layer'), 'absolute', Z.paper);
  wrap.style.left = '0'; wrap.style.top = '0'; wrap.style.width = '0'; wrap.style.height = '0'; wrap.style.pointerEvents = 'none';
  const sc = pt.scene;
  if (pt.page) {
    const g = pageGeometry();
    const sheet = placed(make('div', 'pt-sheet-page'), 'absolute', Z.paper);
    sheet.style.left = '0'; sheet.style.top = `${g.sheetTop}px`; sheet.style.width = `${document.documentElement.clientWidth}px`;
    sheet.style.height = `${Math.max(window.innerHeight, document.body.scrollHeight) - g.sheetTop}px`; sheet.style.background = '#fff'; sheet.style.pointerEvents = 'none';
    wrap.appendChild(sheet);
    const crumb = pt.model ? measureCrumbRow(pt.model) : undefined;
    if (crumb) {
      const c = placed(make('div', 'pt-crumb-new', '/   New page'), 'absolute', Z.paper);
      c.style.left = `${crumb.rect.left + 6}px`; c.style.top = `${crumb.rect.top}px`; c.style.height = `${crumb.rect.height}px`; c.style.pointerEvents = 'none';
      wrap.appendChild(c);
    }
    const row = sc?.tabRow?.rect;
    if (row) {
      const rule = placed(make('div', 'pt-tab-rule'), 'absolute', Z.paper);
      rule.style.left = `${row.left}px`; rule.style.top = `${row.top + row.height}px`; rule.style.width = `${row.width}px`; rule.style.height = '1px'; rule.style.pointerEvents = 'none';
      wrap.appendChild(rule);
    }
    const area = sc?.paper?.rect ?? paperRect();
    if (area) wrap.appendChild(columns(area, Z.paper));
    const field = titleField(g) as HTMLInputElement;
    if (typing !== null) field.value = typing;
    wrap.appendChild(field);
  } else if (sc?.paper) {
    wrap.appendChild(columns(sc.paper.rect, Z.paper));
    // The real tabs, muted: the drawn tab is the shown one.
    const real = unionOf(sc.pills.filter(p => !isDraftId(p.id)).map(p => p.rect));
    if (real) {
      const veil = placed(make('div', 'pt-veil'), 'absolute', Z.paper);
      veil.style.left = `${real.left}px`; veil.style.top = `${real.top}px`; veil.style.width = `${real.width}px`; veil.style.height = `${real.height}px`;
      veil.style.pointerEvents = 'none';
      wrap.appendChild(veil);
    }
  }
  for (const d of tabs) {
    const el = label(d.box, d.mark.text.trim() || 'New tab', 'pt-tab-label' + (d.id === pt.paper ? ' pt-tab-on' : '') + (d.mark.text.trim() ? '' : ' pt-tab-new'));
    el.dataset.draft = d.id;
    wrap.appendChild(el);
  }
  for (const d of pages) wrap.appendChild(label(d.box, d.mark.text.trim() || NEW_PAGE_LABEL, 'pt-tab-label pt-tab-on' + (d.mark.text.trim() ? '' : ' pt-tab-new')));
  layer.appendChild(wrap);
  pt.paperEl = wrap;
  if (typing !== null) { const f = wrap.querySelector<HTMLInputElement>('.pt-page-title'); f?.focus({ preventScroll: true }); }
}
