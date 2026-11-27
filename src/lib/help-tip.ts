/**
 * A small "?" that explains a setting, in the product's own tooltip (the
 * look of the page layer's hover card: white, a thin border, a soft shadow,
 * 12 px text), for extension pages such as the side panel. The page layer's
 * tooltip (content-tooltip.ts) is tied to the BMP page and object cards;
 * this is the plain-text one for extension pages. Styles: styles/help-tip.css.
 *
 * Opens on hover (after a short rest), at once on keyboard focus, and on a
 * click or tap (then it stays until the pointer leaves, Escape, a scroll or
 * a press elsewhere). One tip per document. It is placed once from its
 * measured size before it shows, so it never jumps, and kept inside the
 * window (the side panel is often 320 to 420 px wide): centred under the
 * "?", above it when there is no room below.
 */
import { escapeLayers } from './escape-layers';

/** Rest this long on the "?" before the tip opens. */
export const HELP_TIP_DELAY_MS = 300;
/** Kept from the window's edges. */
const MARGIN = 8;
/** Between the "?" and the tip. */
const GAP = 6;

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }

/** Where a tip of `size` goes for an anchor at `a` in a `vw` x `vh` window:
 *  centred under it, moved in from the sides, above it when it does not fit
 *  below and does fit above, else pinned to the bottom edge. */
export function placeTip(a: Box, size: { width: number; height: number }, vw: number, vh: number): { left: number; top: number; side: 'below' | 'above' } {
  const left = Math.max(MARGIN, Math.min(a.left + a.width / 2 - size.width / 2, vw - size.width - MARGIN));
  const below = a.bottom + GAP;
  if (below + size.height <= vh - MARGIN) return { left, top: below, side: 'below' };
  const above = a.top - GAP - size.height;
  if (above >= MARGIN) return { left, top: above, side: 'above' };
  return { left, top: Math.max(MARGIN, vh - size.height - MARGIN), side: 'below' };
}

interface TipState {
  tip: HTMLElement;
  anchor: HTMLElement | null;
  /** Opened by a click or tap: a pointer leaving a touch does not close it. */
  byClick: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const perDoc = new WeakMap<Document, TipState>();

function stateOf(doc: Document): TipState {
  let st = perDoc.get(doc);
  if (st) return st;
  const tip = doc.createElement('div');
  tip.id = 'crev-help-tip';
  tip.className = 'help-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.append(tip);
  st = { tip, anchor: null, byClick: false, timer: null };
  perDoc.set(doc, st);
  const s = st;
  escapeLayers(doc).register({ kind: 'popover', name: 'help-tip', isOpen: () => !s.tip.hidden, close: () => { hide(doc); } });
  doc.addEventListener('scroll', () => { if (!s.tip.hidden) hide(doc); }, true);
  doc.defaultView?.addEventListener('resize', () => { if (!s.tip.hidden) hide(doc); });
  doc.addEventListener('pointerdown', e => {
    if (!s.tip.hidden && s.anchor && !s.anchor.contains(e.target as Node)) hide(doc);
  }, true);
  return st;
}

function show(anchor: HTMLElement, text: string, byClick: boolean): void {
  const doc = anchor.ownerDocument;
  const st = stateOf(doc);
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  if (st.anchor && st.anchor !== anchor) st.anchor.removeAttribute('aria-describedby');
  st.anchor = anchor;
  st.byClick = byClick || (st.byClick && !st.tip.hidden);
  const tip = st.tip;
  tip.textContent = text;
  tip.classList.remove('on');
  // Measured at its natural size, unseen, then placed once and shown.
  tip.style.visibility = 'hidden';
  tip.style.left = '0px';
  tip.style.top = '0px';
  tip.hidden = false;
  const root = doc.documentElement;
  const p = placeTip(anchor.getBoundingClientRect(), { width: tip.offsetWidth, height: tip.offsetHeight }, root.clientWidth, root.clientHeight);
  tip.style.left = `${Math.round(p.left)}px`;
  tip.style.top = `${Math.round(p.top)}px`;
  tip.dataset.side = p.side;
  tip.style.visibility = '';
  tip.classList.add('on');
  anchor.setAttribute('aria-describedby', tip.id);
  anchor.setAttribute('aria-expanded', 'true');
}

function hide(doc: Document): void {
  const st = perDoc.get(doc);
  if (!st) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  st.tip.hidden = true;
  st.tip.classList.remove('on');
  st.anchor?.removeAttribute('aria-describedby');
  st.anchor?.setAttribute('aria-expanded', 'false');
  st.anchor = null;
  st.byClick = false;
}

/** Close the tip of `doc`. */
export function hideHelpTip(doc: Document = document): void { hide(doc); }

/** Close the tip when its "?" left the page (a redraw replaced it). */
export function dropStaleHelpTip(doc: Document = document): void {
  const st = perDoc.get(doc);
  if (st?.anchor && !st.anchor.isConnected) hide(doc);
}

/** Whether the tip shows, and for which "?". */
export function helpTipAnchor(doc: Document = document): HTMLElement | null {
  const st = perDoc.get(doc);
  return st && !st.tip.hidden ? st.anchor : null;
}

/** A "?" button that explains `about` with `text`. Inside a `<label>` it
 *  does not toggle the label's control (a button is interactive content). */
export function helpTip(text: string, about: string, doc: Document = document): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = 'help-q';
  b.textContent = '?';
  b.setAttribute('aria-label', `About ${about}`);
  b.setAttribute('aria-expanded', 'false');
  b.dataset.help = text;
  const open = (st: TipState) => st.anchor === b && !st.tip.hidden;
  b.addEventListener('pointerenter', e => {
    if (e.pointerType === 'touch') return;
    const st = stateOf(doc);
    if (open(st)) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => { st.timer = null; show(b, text, false); }, HELP_TIP_DELAY_MS);
  });
  b.addEventListener('pointerleave', e => {
    const st = stateOf(doc);
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    // A tap leaves at once (the tip it opened stays). A mouse that leaves
    // closes it, also when the "?" still has focus (a key pressed since
    // would otherwise keep it open under no pointer).
    if (open(st) && !(e.pointerType === 'touch' && st.byClick)) hide(doc);
  });
  b.addEventListener('focus', () => { if (!open(stateOf(doc))) show(b, text, false); });
  b.addEventListener('blur', () => { if (open(stateOf(doc))) hide(doc); });
  b.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const st = stateOf(doc);
    if (open(st) && st.byClick) hide(doc);
    else show(b, text, true);
  });
  b.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !open(stateOf(doc))) return;
    e.preventDefault();
    e.stopPropagation();
    hide(doc);
  });
  return b;
}
