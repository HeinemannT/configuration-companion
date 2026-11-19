/**
 * The controls of the Find bar that other tabs of the Transport window use as
 * they are: the search box and the Areas button with its menu of areas.
 */

import { attrs, btn, el, icon, svg } from '../lib/dom';
import { ICON_FOLDER } from '../lib/icons';
import { typeBadge } from '../lib/type-badge';
import type { TransportRoot } from '../lib/transport-bundle';
import { AREA_LABELS, areasValue, isDefaultArea } from './transport-model';

export interface SearchBox {
  field: HTMLElement;
  input: HTMLInputElement;
}

/** The search field: an icon and one input. `pasteLines`: lines pasted into it become one line of commas (an ID list). */
export function searchBox(o: { placeholder: string; label: string; onInput: (text: string) => void; pasteLines?: boolean }): SearchBox {
  const input = attrs(el('input', 'tr-q') as HTMLInputElement, { type: 'search', placeholder: o.placeholder, 'aria-label': o.label, spellcheck: 'false', autocomplete: 'off' });
  input.addEventListener('input', () => o.onInput(input.value));
  if (o.pasteLines) {
    input.addEventListener('paste', e => {
      const text = e.clipboardData?.getData('text') ?? '';
      if (!/[\r\n]/.test(text)) return;
      e.preventDefault();
      const list = text.trim().split(/\s*[\r\n]+\s*/).join(', ');
      input.setRangeText(list, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
      o.onInput(input.value);
    });
  }
  return { field: el('span', 'tr-qf ui-search', icon('i-search'), input), input };
}

/** The type badge of a row. A class the type table does not know gets a code from its
 *  name (Category: CAT, ListPropertySet: LPS) instead of one code for all, and a Category a folder. */
export function rowBadge(className: string): HTMLElement {
  const badge = typeBadge(className, { size: 'xs' });
  const label = badge.querySelector('.lbl');
  if (label?.textContent !== 'OBJ' || !className) return badge;
  const capitals = className.match(/[A-Z]/g) ?? [];
  label.textContent = capitals.length >= 3 ? capitals.slice(0, 3).join('') : className.slice(0, 3).toUpperCase();
  badge.classList.add('plain');
  if (className === 'Category') badge.querySelector('.tile')?.replaceChildren(svg(ICON_FOLDER));
  return badge;
}

const chev = () => icon('i-chev', 'ic-sm ui-disc-chev');

export interface AreasFilter {
  wrap: HTMLElement;
  btn: HTMLButtonElement;
  pop: HTMLElement;
  box: HTMLElement;
  /** Show the choice: the button's value, whether it differs from the default, the ticks. */
  draw(chosen: ReadonlySet<TransportRoot>, isDefault: boolean): void;
  setOpen(open: boolean): void;
}

/**
 * The Areas button, its Back-to-default cross and the menu of areas.
 * `onToggle` is called when the button is pressed (the owner of the bar may
 * close its other menus first, then calls `setOpen`).
 */
export function areasFilter(o: {
  /** Areas offered, in the order given: the default ones first, a line, the others. */
  areas: readonly TransportRoot[];
  note?: string;
  onChoose: (root: TransportRoot, on: boolean) => void;
  onReset: () => void;
  onToggle?: (open: boolean) => void;
}): AreasFilter {
  const value = el('span', 'fb-v');
  const button = attrs(btn('fb-b tr-where', undefined, () => { if (o.onToggle) o.onToggle(pop.hidden !== false); else api.setOpen(pop.hidden !== false); }, el('span', 'fb-l', 'Areas:'), ' ', value, chev()), { 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const clear = btn('fb-x tr-areasclear', 'Back to the default areas', o.onReset, icon('i-x', 'ic-sm'));
  clear.hidden = true;
  const box = el('span', 'fb tr-areasbox', button, clear);
  const pop = attrs(el('div', 'tr-pop ui-menu pop-areas'), { role: 'group', 'aria-label': 'Areas to look in' });
  pop.hidden = true;
  const boxes = new Map<TransportRoot, HTMLInputElement>();
  const option = (root: TransportRoot) => {
    const ck = attrs(el('input', 'tr-area-ck') as HTMLInputElement, { type: 'checkbox', 'data-root': root });
    boxes.set(root, ck);
    return el('label', 'tr-opt', ck, el('span', '', AREA_LABELS[root]));
  };
  pop.append(...o.areas.filter(isDefaultArea).map(option), el('div', 'tr-pop-sep'), ...o.areas.filter(r => !isDefaultArea(r)).map(option), ...(o.note ? [el('p', 'tr-pop-note', o.note)] : []));
  pop.addEventListener('change', e => {
    const t = e.target as HTMLInputElement;
    const root = t.dataset.root as TransportRoot | undefined;
    if (root) o.onChoose(root, t.checked);
  });
  const wrap = el('span', 'fb-wrap tr-where-wrap', box, pop);
  const api: AreasFilter = {
    wrap, btn: button, pop, box,
    draw(chosen, isDefault) {
      value.textContent = areasValue(chosen);
      box.classList.toggle('set', !isDefault);
      clear.hidden = isDefault;
      for (const [r, ck] of boxes) ck.checked = chosen.has(r);
    },
    setOpen(open) {
      pop.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    },
  };
  return api;
}
