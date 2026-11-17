/**
 * The side panel header's server switcher: the mark inside its status ring,
 * the server name over the user (or the state), and the chevron. One button;
 * the menu it opens lives in sidepanel.ts. What it shows comes from
 * serverControlView (connection-view.ts); this module only draws it.
 *
 * Ring geometry (36 px): circle r=17, stroke 2; the 28 px mark sits at (4, 4)
 * with a 2 px gap to the ring. The mark is `icons/mark-28.svg`, inlined at
 * build time, and never changes with the state. Colours and the connecting
 * spin are in shell.css (`.srv-ring[data-ring]`).
 */
import markSource from '../../icons/mark-28.svg?raw';
import { h, svg } from '../lib/dom';
import { icon } from './icons';
import type { ServerControlView } from './connection-view';

/** Circumference of the r=17 ring, and the spinner arc (about a quarter turn). */
const RING_C = 2 * Math.PI * 17;
const ARC = 24;

const MARK = markSource
  .replace(/\s(?:role|aria-label)="[^"]*"/g, '')
  .trim()
  .replace('<svg ', '<svg x="4" y="4" ');

/** The ring and the mark as one 36 px SVG (no ids: safe to repeat). */
export function ringMarkup(): string {
  return '<svg viewBox="0 0 36 36" width="36" height="36" focusable="false">'
    + '<circle class="ring-track" cx="18" cy="18" r="17"/>'
    + `<circle class="ring-arc" cx="18" cy="18" r="17" stroke-dasharray="${ARC} ${(RING_C - ARC).toFixed(2)}"/>`
    + MARK
    + '</svg>';
}

/** The switcher button, empty until applyServerControl fills it. */
export function buildServerControl(): HTMLButtonElement {
  return h('button', {
    class: 'srvctl', id: 'header-status', type: 'button',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
  },
    h('span', { class: 'srv-ring', 'data-ring': 'none', 'aria-hidden': 'true' }, svg(ringMarkup())),
    h('span', { class: 'srv-text' },
      h('span', { class: 'srv-name' }),
      h('span', { class: 'srv-word' }),
    ),
    icon('i-chev', 'ic-sm srv-chev'),
  ) as HTMLButtonElement;
}

/** Show `v` on the switcher: ring state, the two lines, tooltip and name. */
export function applyServerControl(control: HTMLElement, v: ServerControlView): void {
  control.querySelector('.srv-ring')?.setAttribute('data-ring', v.ring);
  const name = control.querySelector('.srv-name');
  if (name) name.textContent = v.name;
  const word = control.querySelector<HTMLElement>('.srv-word');
  if (word) {
    word.textContent = v.word;
    word.dataset.tone = v.tone;
  }
  control.classList.toggle('empty', v.empty);
  control.title = v.title;
  control.setAttribute('aria-label', [v.name, v.word, 'switch server'].filter(Boolean).join(', '));
}

/** Another panel took over this window: a neutral ring and the reason. */
export function showPanelInactive(control: HTMLElement): void {
  control.querySelector('.srv-ring')?.setAttribute('data-ring', 'none');
  const word = control.querySelector<HTMLElement>('.srv-word');
  if (word) { word.textContent = 'Panel inactive'; word.dataset.tone = 'muted'; }
  control.title = 'Another Companion panel took over this window. Close this one, or reload it to use it again.';
}
