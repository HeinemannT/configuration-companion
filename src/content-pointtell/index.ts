/**
 * Point and tell, lifecycle: turn the mode on and off on the page, keep the measurement true while the
 * page lives, and wire the pieces together. The mode is exclusive with Inspect and Blueprint (the worker
 * and the entry of this bundle see to that); its state is published on `window.__crevPtActive` and sent to
 * the worker, which tells the side panel.
 */
import { sendFireForget } from '../lib/messaging';
import { showToast } from '../lib/toast';
import { describeFailure } from '../lib/connection-copy';
import { findNode } from '../lib/layout/model';
import { getBlueprintPageRid } from '../content-blueprint';
import { blueprintFontFaceCss } from '../content-blueprint/font-face';
import { rememberedTarget } from '../content-blueprint/resume-note';
import POINTTELL_CSS from '../content-pointtell.css';
import MARK_CSS from '../styles/mark.css';
import MOODS_CSS from '../styles/mark-moods.css';
import { LAYER_ID, STYLE_ID, pt, resetState } from './state';
import { Z, renderHover } from './view';
import { renderDock, type DockActions } from './dock';
import { holdReading, look, react, startMascot, stopMascot } from './mascot';
import { clearTags, revalidateTags, scheduleTag } from './tags';
import { renderList, type ListActions } from './list';
import { renderField } from './comment';
import { endVoice, initVoice, listening } from './voice';
import { renderSheet } from './sheet';
import { stageInBlueprint, stageInput } from './stage';
import { directView } from './direct-view';
import { openRoute } from '../lib/point-tell/open-route';
import { draftIdOf, isPageMark, isTabMark } from '../lib/point-tell/drafts';
import { closeSheet, openSheet } from './answer';
import { flashPin, markRect, renderPins, resetBadges } from './pins';
import { fetchLinks, fetchModel } from './service';
import { measureScene, ridSignature } from './measure';
import { applyPaper, draftPills, modelWithDrafts, pageScene, renderPaper, showPaper } from './paper';
import { discardPage, enterPage, leavePage } from './page-draft';
import { closeCard, openCard, renderCard } from './create-card';
import { installSurface, pressTabNamed, releasePointer, setSurfaceCursor } from './pointer';
import { cursorFor, drawTool } from './draw-tool';
import { clearHover } from './actions';
import { InkCanvas } from './ink-canvas';
import { forgetGroup, redo, resetHistory, undo, visibleStrokes } from './ink-marks';
import { takeScreenshot } from './capture';
import { copyMarks } from './copy';
import { colorSets, ensureColors, resetColors } from './service';
import { addMark, clearMarks, closeEditor, closeEditorKeeping, hooks, markByNumber, openInkMark, openMark, openNew, restoreMarks, tabOfMark, targetsExist } from './marks';

const ENABLE_RETRY_MAX = 8;
const ENABLE_RETRY_MS = 180;
const ARM_MS = 6000;
let enableRetries = 0;
let enableRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** The tab was hidden: a tag in flight is taken away, so nothing is half-way when it comes back. */
function onHidden(): void { if (document.hidden) clearTags(); }

declare global { interface Window { __crevPtActive?: boolean } }

function publish(active: boolean): void {
  window.__crevPtActive = active;
  sendFireForget({ type: 'POINT_TELL_STATE', active });
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  // The stylesheet first, fonts last: a malformed @font-face can never swallow the layer's rules.
  s.id = STYLE_ID; s.textContent = POINTTELL_CSS + MARK_CSS + MOODS_CSS + blueprintFontFaceCss(path => chrome.runtime.getURL(path));
  document.head.appendChild(s);
}

/** The one sentence a failed read becomes in the bar. */
export function failureSentence(error: string | undefined): string {
  const raw = (error ?? '').trim();
  if (/not an editable page/i.test(raw)) return 'Point and tell needs the page layout, and this page has none Companion can read.';
  if (/5\.6\.3/.test(raw)) return 'Point and tell needs BMP 5.6.3 or newer.';
  if (!raw) return 'Point and tell could not read this page.';
  const copy = describeFailure({ error: raw });
  return copy.showDetail ? `Point and tell could not read this page: ${raw}` : copy.sentence;
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────

function disarmClear(): void {
  if (pt.clearTimer) { clearTimeout(pt.clearTimer); pt.clearTimer = 0; }
  pt.clearArm = false;
}

const dockActions: DockActions = {
  close: () => disablePointTell(),
  openList: () => { pt.listOpen = !pt.listOpen; if (pt.listOpen) { pt.sheet = null; pt.answer = null; } render(); },
  copy: () => { void copyMarks(); },
  paste: () => { if (pt.sheet) closeSheet(); else openSheet(); },
  undo: () => { undo(); },
  redo: () => { redo(); },
  screenshot: () => { void takeScreenshot(); },
  setTool: (tool) => { pt.tool = tool; setSurfaceCursor(cursorFor()); render(); },
  clear: () => {
    if (!pt.marks.length) return;
    if (!pt.clearArm) {
      pt.clearArm = true;
      pt.clearTimer = window.setTimeout(() => { pt.clearTimer = 0; pt.clearArm = false; render(); }, ARM_MS);
      render();
      return;
    }
    disarmClear();
    pt.listOpen = false;
    clearTags();
    pt.shot = false;
    react('dizzy');
    clearMarks();
    resetHistory(); forgetGroup();
    // Clear discards a drawn page too: the paper page and the mark that drew it.
    if (pt.page) discardPage();
    closeCard();
  },
};

const listActions: ListActions = {
  pageNote: () => openNew([]),
  openMark: (n) => openMark(n),
  goTo: (n) => goTo(n),
};

/** Draw everything from `pt`. The note field is built once per opening, so text being typed survives a redraw. */
export function render(): void {
  if (!pt.active) return;
  renderDock(dockActions);
  renderHover();
  pt.ink?.setStrokes(visibleStrokes());
  renderPaper();
  renderCard(disablePointTell);
  renderPins(openMark);
  renderList(listActions);
  renderSheet({
    // On the paper page of a drawn page the page is created first: the card says so and asks.
    stage: () => { const a = pt.answer; if (pt.page && a?.result && a.snapshot) { closeSheet(); openCard({ text: a.text, snapshot: a.snapshot, result: a.result }); } else stageInBlueprint(disablePointTell); },
    stageDirect: () => { const d = directView(); if (!d) return; if (pt.page) { closeSheet(); openCard(d); } else stageInput(d, disablePointTell); },
    openRoute: (route) => {
      const rid = pt.model ? findNode(pt.model, route.id)?.node.rid : undefined;
      if (rid) openRoute(rid, route); else showToast('That object has no ID on the server yet.', 'info');
    },
  });
  if (!pt.editor) { endVoice(false); pt.fieldEl?.remove(); pt.fieldEl = null; }
  else if (!pt.fieldEl?.isConnected) renderField();
  revalidateTags();
}

hooks.render = render;
hooks.saved = (n, isNew) => {
  react('pleased');
  // A tab with a name is the shown tab: its paper opens.
  const saved = markByNumber(n);
  if (saved && isTabMark(saved) && saved.text.trim()) { showPaper(draftIdOf(n)); remeasure(); }
  // A page with a name opens its paper page.
  if (saved && isPageMark(saved) && saved.text.trim() && !pt.page) enterPage(n);
  // A note made by a click: its tag says Note.
  if (isNew) scheduleTag(n, 0);
};
hooks.remeasure = () => remeasure();
hooks.showPaper = (id) => { showPaper(id); remeasure(); };
hooks.enterPage = (n) => enterPage(n);
hooks.leavePage = () => leavePage();
hooks.showTab = (id) => {
  const tab = pt.model ? findNode(pt.model, id)?.node : null;
  return !!tab && pressTabNamed(tab.name);
};

/** The page measured: with the tabs drawn so far among its tabs, and the paper of one of them in place when it is shown. */
function measureNow(): ReturnType<typeof measureScene> {
  // The paper page of a drawn page has no page behind it to measure.
  const m = pt.page ? { scene: pageScene(pt.model!), foreign: [] } : measureScene(modelWithDrafts(pt.model!), pt.links, draftPills());
  pt.scene = m.scene;
  applyPaper();
  return m;
}

/** Measure the page again and draw what depends on it. */
export function remeasure(): void {
  if (!pt.active || !pt.model) return;
  const { scene, foreign } = measureNow();
  pt.scene = scene;
  pt.foreign = foreign;
  pt.hover = null;
  render();
}

function coalesce(fn: () => void): void {
  if (pt.raf) return;
  pt.raf = requestAnimationFrame(() => { pt.raf = 0; fn(); });
}

/** Bring a mark's object into view and make its pin stand out. */
function reveal(n: number): void {
  const m = markByNumber(n);
  const rect = m ? markRect(m) : null;
  if (rect && (rect.top < window.scrollY || rect.top > window.scrollY + window.innerHeight - 120)) {
    window.scrollTo({ top: Math.max(0, rect.top - 140), behavior: 'smooth' });
  }
  flashPin(n);
}

/** The list took you to a note: its tab, its pin. A note whose object is gone opens for editing instead. */
function goTo(n: number): void {
  const m = markByNumber(n);
  if (!m) return;
  pt.listOpen = false;
  if (!m.targets.length || !targetsExist(m)) { openMark(n); return; }
  if (markRect(m)) { render(); reveal(n); return; }
  const tabId = tabOfMark(m);
  if (tabId && pt.model && hooks.showTab(tabId)) {
    render();
    // BMP draws the tab, the mutation watcher measures it; the pin is there a moment later.
    setTimeout(() => { if (pt.active) { remeasure(); reveal(n); } }, 700);
    return;
  }
  openMark(n);
}

// ── Keeping the measurement true ────────────────────────────────────────────────────────────────

/** Another page is showing (a soft navigation inside BMP): leave this page's notes in storage, read the new page. */
function handlePageNav(): boolean {
  const next = getBlueprintPageRid();
  if (!next) return false;
  if (next === pt.rid) return false;
  const typed = pt.fieldEl?.querySelector('textarea')?.value ?? '';
  if (pt.editor) closeEditor(!!typed.trim(), typed);
  pt.surface?.remove(); pt.surface = null;
  pt.model = null; pt.ctx = null; pt.env = null; pt.scene = null; pt.foreign = []; pt.links = {}; pt.hover = null;
  pt.marks = []; pt.next = 1; pt.listOpen = false;
  pt.page = null; pt.paper = null; closeCard();
  resetHistory(); forgetGroup(); resetBadges();
  pt.rid = next;
  pt.gen += 1;
  pt.phase = 'loading';
  pt.failure = null;
  render();
  void loadPage(next);
  return true;
}

function watchPage(): void {
  pt.onResize = () => { pt.ink?.resize(); coalesce(remeasure); };
  window.addEventListener('resize', pt.onResize, true);
  pt.onScroll = () => pt.ink?.scrolled();
  window.addEventListener('scroll', pt.onScroll, { passive: true });
  pt.onPop = () => { handlePageNav(); };
  window.addEventListener('popstate', pt.onPop);
  pt.onKey = onKey;
  window.addEventListener('keydown', pt.onKey, true);
  let lastH = 0;
  pt.resizeObs = new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height ?? 0;
    if (Math.abs(h - lastH) < 2) return;
    lastH = h;
    // A lazy table grows over many frames: one measurement once the height has settled.
    if (pt.bodyResizeTimer) clearTimeout(pt.bodyResizeTimer);
    pt.bodyResizeTimer = window.setTimeout(() => { pt.bodyResizeTimer = 0; coalesce(remeasure); }, 120);
  });
  pt.resizeObs.observe(document.body);
  pt.ridSig = ridSignature();
  pt.observer = new MutationObserver(() => {
    if (pt.mutRaf || !pt.active) return;
    pt.mutRaf = requestAnimationFrame(() => {
      pt.mutRaf = 0;
      if (!pt.active) return;
      if (handlePageNav()) return;
      const sig = ridSignature();
      if (sig === pt.ridSig) return;
      pt.ridSig = sig;
      remeasure();
    });
  });
  pt.observer.observe(document.body, { childList: true, subtree: true });
}

/** Escape closes the comment field (the mark stays), then the paste panel, then the list. Ctrl+Z undoes the last mark or stroke
 *  (Shift+Ctrl+Z or Ctrl+Y redoes); in a text area with text in it the browser's own undo keeps working. */
function onKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
    const t = e.target;
    const typing = t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || (t instanceof HTMLElement && t.isContentEditable);
    // An empty text area has nothing of its own to undo: the keys then undo the mark that was just drawn.
    if (typing && (t as HTMLTextAreaElement).value !== '') return;
    if (typing && !(t as HTMLElement).closest('#crev-pointtell-layer')) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'y' || e.key === 'Y' || e.shiftKey) redo(); else undo();
    return;
  }
  if (e.key !== 'Escape') return;
  // While listening, Escape only cancels the listening (the field handles it).
  if (pt.editor && listening()) return;
  if (pt.editor) { e.stopPropagation(); forgetGroup(); closeEditorKeeping(); }
  else if (pt.sheet) { e.stopPropagation(); closeSheet(); }
  else if (pt.listOpen) { e.stopPropagation(); pt.listOpen = false; render(); }
}

// ── Loading ─────────────────────────────────────────────────────────────────────────────────────

/** The model is in: read the stored notes, measure, draw and let the pointer in. */
function becomeReady(): void {
  pt.phase = 'ready';
  pt.failure = null;
  restoreMarks();
  const { scene, foreign } = measureNow();
  pt.scene = scene;
  pt.foreign = foreign;
  if (pt.layer && !pt.ink) pt.ink = new InkCanvas(pt.layer);
  if (pt.layer && !pt.surface) pt.surface = installSurface(pt.layer, drawTool(ids => openNew(ids)));
  if (!pt.observer) watchPage();
  render();
  react('look');
  if (pt.wantPage) askNewPage();
  // The colours an answer may name: read once, in the background, so Copy has them.
  if (!colorSets()) void ensureColors();
}

async function loadPage(rid: string): Promise<void> {
  const gen = pt.gen;
  const done = holdReading();
  const res = await fetchModel(rid, rememberedTarget(rid) ?? 'template').finally(done);
  if (!pt.active || pt.gen !== gen) return;
  if (!res?.ok || !res.model || !res.ctx) {
    pt.phase = 'unavailable';
    pt.failure = failureSentence(res?.error);
    if (!pt.observer) watchPage(); // a soft navigation to a page that has a layout still works
    render();
    return;
  }
  pt.model = res.model;
  pt.ctx = res.ctx;
  pt.env = res.env ?? null;
  pt.scope = res.ctx.editingTemplate ? 'template' : 'instance';
  // A templated page shows instance widgets while the layout read is the template's: join them.
  if (pt.scope === 'template' && res.ctx.templateRid) {
    const reading = holdReading();
    const links = await fetchLinks(rid).finally(reading);
    if (!pt.active || pt.gen !== gen) return;
    pt.links = links ?? {};
  }
  becomeReady();
}

export function isPointTellActive(): boolean { return pt.active; }

/** The menu entry "New page here": ask for the page's name beside the breadcrumb (once the layout is read). */
export function startNewPage(): void {
  if (!pt.active) enablePointTell();
  pt.wantPage = true;
  if (pt.phase === 'ready') askNewPage();
}

/** A page mark with no stroke, and its field at the end of the breadcrumb. */
function askNewPage(): void {
  if (!pt.wantPage || pt.page) return;
  pt.wantPage = false;
  const crumb = pt.scene?.crumbRow;
  if (!crumb) { showToast('This page has no breadcrumb to start a new page from.', 'info'); return; }
  const words = `New page under ${crumb.parent ?? 'this page'}`;
  const m = addMark({ text: '', targets: [], reading: words, meaning: { kind: 'add', page: true, place: { into: 'draft:page' }, words } });
  if (m) openInkMark(m.n, [crumb.rect.left + 40, crumb.rect.top + crumb.rect.height]);
}

export function enablePointTell(): void {
  if (pt.active) return;
  initVoice();
  const rid = getBlueprintPageRid();
  if (!rid) {
    // The page may still be drawing (a landing page's object comes from its React tree): ask again shortly.
    if (enableRetries < ENABLE_RETRY_MAX) {
      enableRetries++;
      enableRetryTimer = setTimeout(() => { enableRetryTimer = null; enablePointTell(); }, ENABLE_RETRY_MS);
      return;
    }
    enableRetries = 0;
    showToast('Point and tell: no BMP object on this page', 'error');
    publish(false);
    return;
  }
  enableRetries = 0;
  pt.active = true;
  pt.gen += 1;
  pt.rid = rid;
  pt.phase = 'loading';
  ensureStyle();
  const layer = document.createElement('div');
  layer.id = LAYER_ID;
  // Critical position inline: the layer can never fall into page flow, whatever happens to the stylesheet.
  layer.style.position = 'absolute';
  layer.style.top = '0';
  layer.style.left = '0';
  layer.style.width = '100%';
  layer.style.zIndex = Z.layer;
  layer.style.pointerEvents = 'none';
  // On the document element, not the body: BMP's own observers watch the body and must not see this layer.
  document.documentElement.appendChild(layer);
  pt.layer = layer;
  render();
  startMascot(listening);
  document.addEventListener('visibilitychange', onHidden);
  publish(true);
  void loadPage(rid);
}

export function disablePointTell(): void {
  if (enableRetryTimer) { clearTimeout(enableRetryTimer); enableRetryTimer = null; }
  enableRetries = 0;
  if (!pt.active) return;
  // A note being written is kept: the text in the open field is saved first.
  const typed = pt.fieldEl?.querySelector('textarea')?.value ?? '';
  if (pt.editor && typed.trim()) closeEditor(true, typed);
  endVoice(false);
  // The surface and the layer go first: nothing below can leave something that swallows the page's input.
  pt.surface?.remove();
  pt.layer?.remove();
  releasePointer();
  closeCard();
  look(null);
  stopMascot();
  clearTags();
  document.removeEventListener('visibilitychange', onHidden);
  pt.ink?.destroy();
  resetHistory(); forgetGroup(); resetBadges();
  clearHover();
  disarmClear();
  if (pt.onResize) window.removeEventListener('resize', pt.onResize, true);
  if (pt.onScroll) window.removeEventListener('scroll', pt.onScroll);
  if (pt.onPop) window.removeEventListener('popstate', pt.onPop);
  if (pt.onKey) window.removeEventListener('keydown', pt.onKey, true);
  if (pt.raf) cancelAnimationFrame(pt.raf);
  if (pt.mutRaf) cancelAnimationFrame(pt.mutRaf);
  if (pt.bodyResizeTimer) clearTimeout(pt.bodyResizeTimer);
  pt.observer?.disconnect();
  pt.resizeObs?.disconnect();
  document.getElementById(STYLE_ID)?.remove();
  resetColors();
  resetState();
  publish(false);
}
