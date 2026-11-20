/**
 * Choosing a color for an image: the workspace's color sets as swatches
 * (one set at a time, picked from a list), a hex field and, where the
 * browser has it, pick from the screen. Used by Swap colors, One color and
 * the shape behind an icon. One popover at a time; Escape or a click
 * outside closes it.
 */
import { attrs, btn, el } from '../lib/dom';
import { hexFromRgbText, normalizeHex } from '../lib/colors-images/color-math';
import type { ColorSetData } from '../lib/types';
import { pageIcon } from './icons';

interface EyeDropperCtor { new(): { open(): Promise<{ sRGBHex: string }> } }

/** The browser's EyeDropper, when it has one. */
function eyeDropper(): EyeDropperCtor | null {
  const E = (globalThis as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  return typeof E === 'function' ? E : null;
}

/** A button that picks a color from the screen; null where the browser cannot. */
export function pickFromScreenButton(onHex: (hex: string) => void): HTMLButtonElement | null {
  const E = eyeDropper();
  if (!E) return null;
  const b = btn('ci-ib framed', 'Pick from the screen', () => {
    void new E().open().then(r => {
      const hex = normalizeHex(r.sRGBHex) ?? hexFromRgbText(r.sRGBHex);
      if (hex) onHex(hex);
    }, () => undefined);
  }, pageIcon('drop'));
  b.title = 'Pick from the screen';
  return b;
}

export interface ColorPopOptions {
  /** The element the popover opens beside. */
  anchor: HTMLElement;
  /** The positioned element the popover is placed in. */
  host: HTMLElement;
  value: string;
  /** The workspace's sets; null while they are read. */
  sets: ColorSetData[] | null;
  /** The value before a swap: "Reset" goes back to it. */
  original?: string;
  onPick(hex: string): void;
}

let current: { close(): void } | null = null;
let lastSet = '';

export function closeColorPop(): void { current?.close(); }

export function openColorPop(o: ColorPopOptions): { close(): void; setSets(sets: ColorSetData[] | null): void } {
  closeColorPop();
  const pop = attrs(el('div', 'ci-pop'), { role: 'dialog', 'aria-label': 'Choose a color' });
  let value = o.value;
  let sets = o.sets;
  const chip = attrs(el('span', 'ci-chip lg'), { style: `background:${value}` });
  const input = attrs(el('input', 'ci-inp mono') as HTMLInputElement, { 'aria-label': 'Hex value', spellcheck: 'false', maxlength: '7' });
  input.value = value;
  const set = (hex: string, fromInput = false) => {
    value = hex; chip.style.background = hex;
    if (!fromInput) input.value = hex;
    input.removeAttribute('aria-invalid');
    o.onPick(hex);
    paintSwatches();
  };
  input.addEventListener('input', () => {
    const v = normalizeHex(input.value);
    if (!v) { input.setAttribute('aria-invalid', 'true'); return; }
    set(v, true);
  });
  const head = el('div', 'ci-pop-h');
  const grid = el('div', 'ci-popsw');
  function paintSwatches(): void {
    if (!sets) { head.replaceChildren(el('span', 'muted', 'Reading the colors…')); grid.replaceChildren(); return; }
    if (!sets.length) { head.replaceChildren(el('span', 'muted', 'No color sets')); grid.replaceChildren(); return; }
    const chosen = sets.find(s => s.id === lastSet) ?? sets[0];
    lastSet = chosen.id;
    const select = attrs(el('select', 'ci-popsel') as HTMLSelectElement, { 'aria-label': 'Color set' });
    for (const s of sets) { const opt = el('option', '', s.name || s.id) as HTMLOptionElement; opt.value = s.id; opt.selected = s.id === chosen.id; select.append(opt); }
    select.addEventListener('change', () => { lastSet = select.value; paintSwatches(); });
    head.replaceChildren(select);
    grid.replaceChildren(...chosen.colors.map(c => {
      const hex = hexFromRgbText(c.rgb) ?? '#000000';
      const b = btn(hex === value ? 'on' : '', `${c.name} ${hex}`, () => set(hex));
      b.style.background = hex;
      b.title = `${c.name}  ${hex}`;
      return b;
    }));
  }
  paintSwatches();
  const drop = pickFromScreenButton(hex => set(hex));
  pop.append(head, grid, el('div', 'ci-hexrow', chip, input, drop));
  if (o.original && o.original !== o.value) pop.append(el('div', 'ci-pop-f', el('span', 'ci-chip', ''), btn('ci-link', undefined, () => { set(o.original!); close(); }, 'Reset')));
  const resetChip = pop.querySelector<HTMLElement>('.ci-pop-f .ci-chip');
  if (resetChip && o.original) resetChip.style.background = o.original;
  o.host.append(pop);

  // Beside the anchor, inside the host; above it when there is no room below.
  const place = () => {
    const h = o.host.getBoundingClientRect(), a = o.anchor.getBoundingClientRect();
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    let left = a.left - h.left;
    if (left + w > h.width - 8) left = Math.max(8, a.right - h.left - w);
    let top = a.bottom - h.top + 6;
    if (top + ph > h.height - 8) top = Math.max(8, a.top - h.top - ph - 6);
    pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  };
  place();
  const onDown = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && !o.anchor.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); o.anchor.focus(); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey);
  function close(): void {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    o.anchor.setAttribute('aria-expanded', 'false');
    if (current === handle) current = null;
  }
  o.anchor.setAttribute('aria-expanded', 'true');
  const handle = { close, setSets(next: ColorSetData[] | null) { sets = next; paintSwatches(); place(); } };
  current = handle;
  return handle;
}
