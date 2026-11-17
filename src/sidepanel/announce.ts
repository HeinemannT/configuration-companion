/**
 * Screen-reader announcements for state changes: polite by default,
 * assertive for errors. Two visually hidden live regions on the body.
 */

function region(doc: Document, assertive: boolean): HTMLElement {
  const id = assertive ? 'sp-live-alert' : 'sp-live-status';
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement('div');
    el.id = id;
    el.className = 'sr-only';
    el.setAttribute('role', assertive ? 'alert' : 'status');
    el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    el.setAttribute('aria-atomic', 'true');
    doc.body.append(el);
  }
  return el;
}

/** Create both regions up front: a region added at the moment it speaks is often not heard. */
export function mountLiveRegions(doc: Document = document): void {
  region(doc, false);
  region(doc, true);
}

/** Say `text` once. Repeating the same text re-announces it. */
export function announce(text: string, assertive = false, doc: Document = document): void {
  if (!text || !doc.body) return;
  const el = region(doc, assertive);
  el.textContent = '';
  // A separate task so the cleared region is noticed before the new text.
  setTimeout(() => { el.textContent = text; }, 30);
}
