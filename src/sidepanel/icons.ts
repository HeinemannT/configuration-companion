/**
 * Side panel shell icons. The object window's sprite (mounted by Browse's
 * mountSprites) supplies the shared symbols (i-chev, i-copy, i-check,
 * i-pencil, i-plus, i-search, i-warn, i-x, i-retry); this sprite adds the
 * ones only the shell, Connect and Log use. Icons are 16 px line glyphs
 * styled by `.ui .ic` in src/styles/ui.css.
 */
import { mountSprites } from './tabs/browse/view';

const SHELL_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="s-terminal" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10.5H11"/></symbol>
<symbol id="s-shield" viewBox="0 0 16 16"><path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z"/></symbol>
<symbol id="s-crosshair" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/></symbol>
<symbol id="s-blueprint" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.5h11M6.5 6.5v7"/></symbol>
<symbol id="s-refresh" viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/></symbol>
<symbol id="s-pulse" viewBox="0 0 16 16"><path d="M2 8h3l2-4 2 8 2-4h3"/></symbol>
<symbol id="s-trash" viewBox="0 0 16 16"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></symbol>
<symbol id="s-xc" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M6 6l4 4M10 6l-4 4"/></symbol>
<symbol id="s-warn" viewBox="0 0 16 16"><path d="M8 2.5l6 10.5H2z M8 7v3 M8 11.6v.01"/></symbol>
<symbol id="s-dot" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2" fill="currentColor"/></symbol>
<symbol id="s-check" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></symbol>
<symbol id="s-download" viewBox="0 0 16 16"><path d="M8 2.5v7M5 7l3 3 3-3M3 13h10"/></symbol>
<symbol id="s-globe" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.2 2 2.2 10 0 12M8 2c-2.2 2-2.2 10 0 12"/></symbol>
<symbol id="s-key" viewBox="0 0 16 16"><circle cx="5" cy="10.5" r="2.5"/><path d="M6.8 8.7L13 2.5M11 4.5l1.5 1.5"/></symbol>
<symbol id="s-eye" viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></symbol>
<symbol id="s-help" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="M6.2 6.3A1.9 1.9 0 0 1 8 5c1 0 1.9.7 1.9 1.7 0 1.2-1.9 1.4-1.9 2.6M8 11.3v.01"/></symbol>
</defs></svg>`;

let mounted = false;

/** Mount the shared and the shell sprites once per document. */
export function mountShellSprites(doc: Document = document): void {
  mountSprites(doc);
  if (mounted || doc.getElementById('sp-sprites')) return;
  const host = doc.createElement('div');
  host.id = 'sp-sprites';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  host.innerHTML = SHELL_SPRITE;
  doc.body.appendChild(host);
  mounted = true;
}

/** A sprite icon, aria-hidden (the shared DOM kit's). */
export { icon } from '../lib/dom';
