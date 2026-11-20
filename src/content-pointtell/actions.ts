/**
 * Point and tell: what the user's pointer does to the state. Each function changes `pt` and asks the
 * view to draw; nothing here builds DOM.
 */
import { showToast } from '../lib/toast';
import { findNode } from '../lib/layout/model';
import { hitTest } from '../lib/point-tell/hit';
import { isDraftId } from '../lib/point-tell/drafts';
import { hooks } from './marks';
import { pageMarkAt } from './paper';
import type { PtPointer } from './pointer';
import { nativeTabAt, pressNative } from './pointer';
import { pt } from './state';
import { renderHover } from './view';

export const FOREIGN_SENTENCE = 'Only on this instance. Switch Blueprint to This instance to note it.';

/** The object under the pointer: a tab pill (with Alt), else the deepest object the layout holds, else one it does not. */
function targetAt(p: PtPointer): { id: string; foreign: boolean; tag: string } | null {
  const scene = pt.scene;
  if (!scene) return null;
  const model = scene.model;
  const nameOf = (id: string): string => { const n = findNode(model, id)?.node; return n ? `${n.kind === 'tab' ? 'Tab' : n.className} · ${n.name}` : id; };
  if (p.alt) {
    const pill = hitTest(scene.pills, p.x, p.y);
    if (pill) return { id: pill.id, foreign: false, tag: nameOf(pill.id) };
  }
  const hit = hitTest([...scene.targets, ...pt.foreign], p.x, p.y);
  if (!hit) return null;
  return hit.id.startsWith('foreign:') ? { id: hit.id, foreign: true, tag: FOREIGN_SENTENCE } : { id: hit.id, foreign: false, tag: nameOf(hit.id) };
}

export function hoverAt(p: PtPointer): void {
  const next = targetAt(p);
  if (next?.id === pt.hover?.id && next?.tag === pt.hover?.tag) return;
  pt.hover = next;
  renderHover();
}

export function clearHover(): void {
  if (!pt.hover) return;
  pt.hover = null;
  renderHover();
}

/**
 * Open a note at the point for voice (a still press): on the object a click would note, else on the page. A tab pill
 * is not switched and a drawn page is not opened. False (and the usual sentence) for an object only on this instance.
 */
export function noteAt(p: PtPointer, openFor: (ids: string[]) => void): boolean {
  if (!pt.scene) return false;
  const t = targetAt(p);
  if (t?.foreign) { showToast(FOREIGN_SENTENCE, 'info'); return false; }
  openFor(t ? [t.id] : []);
  return true;
}

/** What a click does. A plain click on a BMP tab pill switches the tab; Alt on it, or a click on an object, is a note. */
export function clickAt(p: PtPointer, openFor: (ids: string[]) => void): void {
  const scene = pt.scene;
  if (!scene) return;
  // The paper page of a drawn page closes with a click on the breadcrumb (BMP's own crumbs are not pressed); a page's label opens it.
  if (pt.page && p.cy < (scene.tabRow?.rect.top ?? 0) - 60) { hooks.leavePage(); return; }
  const pageN = pt.page ? null : pageMarkAt(p.x, p.y);
  if (pageN !== null) { hooks.enterPage(pageN); return; }
  const pill = !p.alt ? hitTest(scene.pills, p.x, p.y) : null;
  if (pill && isDraftId(pill.id)) { hooks.showPaper(pill.id); return; }
  if (pill) {
    // BMP switches to its own tab: a drawn tab's paper goes.
    if (pt.paper) hooks.showPaper(null);
    const native = nativeTabAt(p.cx, p.cy);
    if (native) pressNative(native);
    return;
  }
  const t = targetAt(p);
  if (!t) return;
  if (t.foreign) { showToast(FOREIGN_SENTENCE, 'info'); return; }
  openFor([t.id]);
}
