/**
 * The image library inside the Images tab: three collections of ready-made
 * images (status symbols, GRC object icons, button icons), each in groups.
 * They sit in the sidebar's tree under "Library", below the BMP folders, each
 * collection foldable to its groups, and show
 * in the main area with a strip that says they are not in BMP and where
 * additions go. The one search of the tab also searches them (by name,
 * group, collection and keywords). The person selects several, sets one
 * color for them (or swaps single colors), picks the BMP folder (or drags
 * them onto a folder in the sidebar) and adds them: they arrive under New
 * exactly as dropped files do, with IDs proposed from their names, and stay
 * adjustable there. The data loads once (its own chunk); nothing here writes.
 */
import { libraryIcon } from './icons';
import { attrs, btn, el, icon } from '../lib/dom';
import { normalizeHex } from '../lib/colors-images/color-math';
import { DEFAULT_ADJUST } from '../lib/colors-images/image-process';
import {
  allItems, coloredSvg, colorsOf, libraryFiles, loadLibrary, searchLibrary, WHITE,
  type CollectionId, type Library, type LibraryCollection, type LibraryColor, type LibraryItem,
} from '../lib/colors-images/image-library';
import { CURRENT_COLOR } from '../lib/colors-images/svg-colors';
import type { ColorSetData } from '../lib/types';
import { closeColorPop, openColorPop } from './color-pop';
import type { PickedFile } from './dropped-files';
import { treeRow } from './common';
import type { GlyphName } from '../lib/object-glyphs';

/** The shared object glyph each collection is drawn with in the sidebar. */
const COLLECTION_GLYPH: Record<CollectionId, GlyphName> = { status: 'status', grc: 'control', buttons: 'button' };

export interface LibraryHost {
  /** The positioned element color popovers open in (the Images view). */
  host: HTMLElement;
  /** Why nothing can be added now (the list is not read), or null. */
  cannotAdd(): string | null;
  colorSets(): ColorSetData[] | null;
  needColorSets(onReady: () => void): void;
  /** A picker of the BMP folders. */
  folderSelect(current: string, onChange: (id: string) => void, label: string): HTMLElement;
  /** The name of a folder as a button says it ("Status"). */
  folderName(id: string): string;
  /** Where images of this kind go unless the person picks another folder. */
  defaultDestination(kind: CollectionId | null): string;
  onAdd(files: PickedFile[], folderId: string): void;
  /** The library's state changed: draw the grid, the panel and the sidebar again. */
  changed(): void;
  /** The BMP folder under the pointer while library images are dragged, or null. */
  folderAt(x: number, y: number): string | null;
  /** Show the folders as drop targets while dragging (`over`: the one under the pointer). */
  dropHint(over: string | null, dragging: boolean): void;
}

export interface LibraryView {
  /** Read the library data (once). */
  load(): void;
  /** The Library section of the sidebar. */
  side(active: CollectionId | null, open: (id: CollectionId, group?: string) => void): HTMLElement;
  /** A collection in the main area: the strip, then its groups. */
  view(id: CollectionId): HTMLElement[];
  /** The library's part of a search: "Library", with a count, or that nothing matches. */
  search(query: string): HTMLElement;
  /** The panel while library images are selected, else null. */
  panel(): HTMLElement[] | null;
  /** The panel in a collection with nothing selected. */
  idlePanel(): HTMLElement[];
  hasSelection(): boolean;
  clearSelection(): void;
  /** Forget the folder the person picked: the default applies again. */
  resetDestination(): void;
  /** The folder additions go to now. */
  destination(): string;
}

const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
/** At most this many selected images are shown in the preview. */
const PREVIEW = 12;
const ORIGINAL: LibraryColor = { mode: 'original', hex: DEFAULT_ADJUST.color.hex, map: {} };
/** The color a selection starts with: button icons white (for dark buttons), the rest as drawn. */
const startColor = (c: CollectionId): LibraryColor => (c === 'buttons' ? { mode: 'one', hex: WHITE, map: {} } : { ...ORIGINAL });

export function createLibrary(h: LibraryHost): LibraryView {
  let lib: Library | null = null;
  let loadError = '';
  let loading: Promise<void> | null = null;
  let active: CollectionId = 'status';
  const variant: Record<CollectionId, string> = { status: 'flat', grc: 'line', buttons: 'regular' };
  const selection = new Set<string>();
  let color: LibraryColor = { ...ORIGINAL };
  let picked: string | null = null;
  const colored = new Map<string, string>();
  let suppressClick = false;

  const collection = (id: CollectionId = active): LibraryCollection | undefined => lib?.collections.find(c => c.id === id);
  const byKey = new Map<string, LibraryItem>();
  const selectedItems = (): LibraryItem[] => [...selection].map(k => byKey.get(k)).filter((i): i is LibraryItem => !!i);
  const svgOf = (item: LibraryItem) => item.svg[variant[item.collection]] ?? Object.values(item.svg)[0];
  const white = () => color.mode === 'one' && normalizeHex(color.hex) === WHITE;

  /** The kind of image being added: of the selection when it is one kind, else of the collection last shown. */
  /** The kind most search hits are of, while a search is shown: nothing is selected yet, and the
   *  collection last opened says nothing about what was searched for. */
  let hitKind: CollectionId | null = null;
  function kind(): CollectionId {
    const kinds = new Set(selectedItems().map(i => i.collection));
    if (kinds.size === 1) return [...kinds][0];
    return kinds.size === 0 && hitKind ? hitKind : active;
  }
  const destination = () => picked ?? h.defaultDestination(kind());

  /** The image as it would be added; cached by its color choice. */
  function shown(item: LibraryItem): string {
    const svg = svgOf(item);
    if (!selection.has(item.key) || color.mode === 'original') return svg;
    const sig = `${item.key}|${variant[item.collection]}|${JSON.stringify(color)}`;
    let out = colored.get(sig);
    if (out === undefined) {
      try { out = coloredSvg(svg, color); } catch { out = svg; }
      if (colored.size > 600) colored.clear();
      colored.set(sig, out);
    }
    return out;
  }

  function select(items: readonly LibraryItem[], on: boolean): void {
    const was = selection.size;
    for (const i of items) { if (on) selection.add(i.key); else selection.delete(i.key); }
    if (!was && selection.size) color = startColor(items[0].collection);
    if (!selection.size) color = { ...ORIGINAL };
    closeColorPop();
  }

  function load(): void {
    if (lib || loading) return;
    loadError = '';
    loading = loadLibrary().then(l => {
      lib = l;
      for (const i of allItems(l)) byKey.set(i.key, i);
    }, (e: unknown) => { loadError = e instanceof Error ? e.message : String(e); }).finally(() => { loading = null; h.changed(); });
  }

  // ── the sidebar section ───────────────────────────────────────────

  /** Collections the person folded or unfolded in the sidebar; the rest are open only while shown. */
  const unfolded = new Map<CollectionId, boolean>();

  function side(current: CollectionId | null, open: (id: CollectionId, group?: string) => void): HTMLElement {
    const sec = attrs(el('section', 'ci-sec lib'), { 'aria-label': 'Library' });
    sec.append(el('div', 'ci-sec-h', el('span', 'ci-tglyph', libraryIcon()), el('span', 'ci-sec-t', 'Library')),
      el('p', 'ci-sec-cap', 'Not in BMP yet'));
    if (lib) {
      for (const c of lib.collections) {
        const on = c.id === current;
        const expanded = unfolded.get(c.id) ?? on;
        const n = c.groups.reduce((s, g) => s + g.items.length, 0);
        sec.append(treeRow({
          label: c.name, depth: 0, glyph: `o-${COLLECTION_GLYPH[c.id]}`, count: n, on, expanded,
          onToggle: () => { unfolded.set(c.id, !expanded); h.changed(); },
          onOpen: () => { active = c.id; if (unfolded.get(c.id) === false) unfolded.delete(c.id); open(c.id); },
          ...(c.description ? { title: `${c.name}. ${c.description}` } : {}),
        }));
        if (!expanded) continue;
        for (const g of c.groups) {
          sec.append(treeRow({ label: g.name, depth: 1, glyph: 'dot', count: g.items.length, onOpen: () => { active = c.id; open(c.id, g.name); } }));
        }
      }
    } else if (loadError) {
      sec.append(el('p', 'ci-warn ci-sec-cap', `The library could not be loaded. ${loadError}`));
    } else {
      sec.append(...[64, 72, 56].map(w => attrs(el('div', 'ci-skel-row'), { style: `width:${w}%` })));
    }
    return sec;
  }

  // ── the images ────────────────────────────────────────────────────

  function startDrag(e: PointerEvent, item: LibraryItem): void {
    if (e.button !== 0 || h.cannotAdd()) return;
    const x0 = e.clientX, y0 = e.clientY;
    let ghost: HTMLElement | null = null;
    let over: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
        if (!selection.has(item.key)) { select([item], true); h.changed(); }
        const n = selection.size;
        ghost = el('div', 'ci-dragghost', libraryIcon(), el('span', '', `${n} image${n === 1 ? '' : 's'}`));
        // Positioned inline: the drag follows the pointer above everything.
        ghost.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none';
        document.body.append(ghost);
        h.dropHint(null, true);
      }
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
      const f = h.folderAt(ev.clientX, ev.clientY);
      if (f !== over) { over = f; h.dropHint(f, true); }
    };
    const end = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (!ghost) return;
      ghost.remove();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      h.dropHint(null, false);
      if (drop && over) addSelected(over);
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function tile(item: LibraryItem): HTMLElement {
    const on = selection.has(item.key);
    const thumb = el('div', `ci-thumb${on && white() ? ' on-dark' : ''}`,
      attrs(el('img'), { src: svgUrl(shown(item)), alt: '', draggable: 'false' }),
      attrs(el('span', 'ci-libmark', libraryIcon()), { title: 'From the library, not in BMP' }));
    if (on) thumb.append(el('span', 'ci-ck', icon('i-check', 'ic-sm')));
    const label = item.code ? `${item.code} ${item.label}` : item.label;
    const pick = btn('ci-itile-pick', `${label}, from the library`, () => {
      if (suppressClick) return;
      select([item], !selection.has(item.key));
      h.changed();
    }, thumb);
    pick.setAttribute('aria-pressed', String(on));
    pick.addEventListener('pointerdown', e => startDrag(e, item));
    return attrs(el('div', `ci-itile ci-libtile${on ? ' on' : ''}`, pick, attrs(el('div', 'ci-nm', label), { title: label })), { 'data-key': item.key });
  }

  function groupBlock(name: string, items: readonly LibraryItem[], cls = '', of = ''): HTMLElement {
    const all = items.every(i => selection.has(i.key));
    const sel = btn('ci-link quiet ci-gsel', undefined, () => { select(items, !all); h.changed(); }, all ? 'Clear' : 'Select all');
    return attrs(el('section', `ci-group${cls ? ` ${cls}` : ''}`, el('div', 'ci-ghead', name, of ? el('span', 'ci-gof', of) : null, el('span', 'ci-gn', String(items.length)), sel),
      el('div', 'ci-igrid lib', ...items.map(tile))), { 'data-group': name });
  }

  function segment(label: string, options: Array<{ value: string; text: string }>, current: string, set: (v: string) => void): HTMLElement {
    const g = attrs(el('span', 'ci-seg'), { role: 'group', 'aria-label': label });
    for (const o of options) {
      const b = btn(o.value === current ? 'on' : '', undefined, () => set(o.value), o.text);
      b.setAttribute('aria-pressed', String(o.value === current));
      g.append(b);
    }
    return g;
  }

  /** "Add to: <folder>": where additions go. */
  function destinationPicker(): HTMLElement {
    return el('label', 'ci-dest', el('span', 'ci-lab-in', 'Add to'),
      h.folderSelect(destination(), id => { picked = id; h.changed(); }, 'Folder the library images are added to'));
  }

  function view(id: CollectionId): HTMLElement[] {
    active = id;
    const c = collection(id);
    if (!c) {
      return [loadError ? el('div', 'ci-state', el('span', '', `The library could not be loaded. ${loadError}`)) : el('div', 'ci-scroll', el('div', 'ci-skel-bar'))];
    }
    const strip = el('div', 'ci-libstrip',
      el('div', 'ci-libstrip-t', libraryIcon(), el('b', '', 'Library'), el('span', 'ci-libstrip-c', c.name)),
      el('div', 'ci-libstrip-s', 'Not in BMP until you add them. Select images, then add them to a folder or drag them onto one.'),
      el('div', 'ci-libstrip-r',
        c.variantLabel ? el('span', 'ci-inl', el('span', 'ci-lab-in', c.variantLabel),
          segment(c.variantLabel, c.variants.map(v => ({ value: v.id, text: v.label })), variant[c.id], v => { variant[c.id] = v; h.changed(); })) : null,
        destinationPicker()));
    return [strip, ...c.groups.map(g => groupBlock(g.name, g.items))];
  }

  function search(query: string): HTMLElement {
    const head = (n: number | null, extra?: HTMLElement) => el('div', 'ci-shead', libraryIcon(), el('span', '', 'Library'),
      n === null ? null : el('span', 'ci-gn', String(n)), extra ?? null);
    if (!lib) {
      return el('section', 'ci-sres lib', head(null), loadError ? el('p', 'ci-warn', `The library could not be loaded. ${loadError}`) : el('div', 'ci-skel-bar short'));
    }
    const hits = searchLibrary(allItems(lib), query);
    {
      const n = new Map<CollectionId, number>();
      for (const i of hits) n.set(i.collection, (n.get(i.collection) ?? 0) + 1);
      hitKind = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    }
    const sec = el('section', 'ci-sres lib', head(hits.length, hits.length ? destinationPicker() : undefined));
    if (!hits.length) {
      sec.append(el('p', 'ci-nomatch', `No image in the library matches “${query.trim()}”.`));
      return sec;
    }
    sec.append(el('p', 'ci-sres-cap', 'Ready-made images. Not in BMP until you add them.'));
    // By group, the group of the best match first.
    const groups = new Map<string, LibraryItem[]>();
    for (const i of hits) {
      const k = `${i.collection}|${i.group}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    for (const items of groups.values()) sec.append(groupBlock(items[0].group, items, 'sub', collection(items[0].collection)?.name ?? ''));
    return sec;
  }

  // ── the selection: color, folder, then Add ────────────────────────

  function colorChip(hex: string, label: string, onPick: (hex: string) => void, text?: string, original?: string): HTMLButtonElement {
    const b = btn('ci-cchip', label, () => {
      if (b.getAttribute('aria-expanded') === 'true') { closeColorPop(); return; }
      const pop = openColorPop({ anchor: b, host: h.host, value: hex, sets: h.colorSets(), ...(original ? { original } : {}), onPick });
      h.needColorSets(() => pop.setSets(h.colorSets()));
    }, attrs(el('i'), { style: `background:${hex}` }), text ? el('span', '', text) : null);
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    return b;
  }

  /** A new color: the tiles and the preview follow; the panel is drawn again only when asked (not while typing a hex). */
  function setColor(next: Partial<LibraryColor>, redraw = true): void {
    color = { ...color, ...next };
    if (redraw) { h.changed(); return; }
    // Keep the focused hex input: redraw the tiles and the preview in place.
    for (const t of h.host.querySelectorAll<HTMLElement>('.ci-libtile.on')) {
      const key = t.dataset.key;
      const item = key ? byKey.get(key) : undefined;
      if (!item) continue;
      t.querySelector('img')?.setAttribute('src', svgUrl(shown(item)));
      t.querySelector('.ci-thumb')?.classList.toggle('on-dark', white());
    }
    drawPreview();
    const add = h.host.querySelector<HTMLButtonElement>('.ci-lib-add');
    if (add) add.textContent = addLabel();
  }

  const previewBox = el('div', 'ci-preview lib');
  function drawPreview(): void {
    const items = selectedItems();
    previewBox.replaceChildren(el('div', 'ci-pv-imgs', ...items.slice(0, PREVIEW).map(i => attrs(el('img'), { src: svgUrl(shown(i)), alt: '' }))),
      items.length > PREVIEW ? el('span', 'ci-pv-size', `and ${items.length - PREVIEW} more`) : '');
    previewBox.classList.toggle('many', items.length > 1);
    previewBox.classList.toggle('on-dark', items.length > 0 && white());
  }

  /** The colors of the selection, for Swap colors: most used first. */
  function selectionColors(): string[] {
    const counts = new Map<string, number>();
    for (const i of selectedItems()) for (const k of colorsOf(svgOf(i))) counts.set(k, (counts.get(k) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }

  const addLabel = () => `Add ${selection.size} to ${h.folderName(destination()) || 'a folder'}`;

  function panel(): HTMLElement[] | null {
    const items = selectedItems();
    const n = items.length;
    if (!n) return null;
    const rows: HTMLElement[] = [];
    rows.push(el('div', 'ci-prop', el('span', '', 'Color'), segment('Color', [
      { value: 'original', text: 'Original' }, { value: 'one', text: 'One color' }, { value: 'swap', text: 'Swap colors' },
    ], color.mode, v => setColor({ mode: v as LibraryColor['mode'] }))));
    if (color.mode === 'one') {
      const hexInput = attrs(el('input', 'ci-inp mono') as HTMLInputElement, { 'aria-label': 'Color', spellcheck: 'false', maxlength: '7' });
      hexInput.value = color.hex;
      const chip = colorChip(color.hex, 'Choose a color', hex => {
        hexInput.value = hex; hexInput.removeAttribute('aria-invalid');
        chip.querySelector('i')!.setAttribute('style', `background:${hex}`);
        setColor({ hex });
      });
      hexInput.addEventListener('input', () => {
        const v = normalizeHex(hexInput.value);
        if (!v) { hexInput.setAttribute('aria-invalid', 'true'); return; }
        hexInput.removeAttribute('aria-invalid');
        chip.querySelector('i')!.setAttribute('style', `background:${v}`);
        setColor({ hex: v }, false);
      });
      // White, for icons on dark buttons: one click, and the tiles turn dark to show them.
      const whiteBtn = btn(`ci-cchip${white() ? ' chg' : ''}`, 'White, for dark buttons', () => setColor({ hex: WHITE }),
        attrs(el('i'), { style: `background:${WHITE}` }), el('span', '', 'White'));
      whiteBtn.title = 'White, for dark buttons';
      rows.push(el('div', 'ci-prop', el('span', ''), el('span', 'ci-inl', chip, hexInput, whiteBtn)));
      rows.push(el('div', 'ci-prop', el('span', ''), el('span', 'ci-hint', 'White parts stay white; light fills become a light tint of the color. The ID ends with the color.')));
    } else if (color.mode === 'swap') {
      const chips = selectionColors().map(c => {
        const to = color.map[c];
        const was = c === CURRENT_COLOR ? null : c;
        const shownHex = to ?? (c === CURRENT_COLOR ? '#000000' : c);
        const label = to ? to.slice(1) : c === CURRENT_COLOR ? 'Text color' : c.slice(1);
        const chip = colorChip(shownHex, `Swap ${c === CURRENT_COLOR ? 'the text color' : c}`, hex => {
          const map = { ...color.map };
          if (hex === was) delete map[c]; else map[c] = hex;
          setColor({ map });
        }, label, was ?? undefined);
        if (to) { chip.classList.add('chg'); chip.title = `${c === CURRENT_COLOR ? 'Text color' : c} → ${to}`; }
        return chip;
      });
      rows.push(el('div', 'ci-prop top', el('span', ''), chips.length ? el('div', 'ci-swaps', ...chips) : el('span', 'ci-hint', 'No colors to swap')));
    }
    const noted = items.filter(i => collection(i.collection)?.description);
    if (noted.length) {
      rows.push(el('div', 'ci-prop stack', el('span', '', 'Description'),
        el('span', 'ci-hint', `${noted.length === n ? '' : `The ${noted.length} button icons get `}${collection('buttons')!.description}`)));
    }
    rows.push(el('div', 'ci-prop', el('span', '', 'Add to'), h.folderSelect(destination(), id => { picked = id; h.changed(); }, 'Folder the library images are added to')));
    const why = h.cannotAdd();
    const add = btn('ui-btn primary ci-lib-add', undefined, () => addSelected(), addLabel());
    add.disabled = !!why || !destination();
    if (why) add.title = why;
    drawPreview();
    return [
      el('div', 'ci-ph', libraryIcon(), el('span', 'ci-title', `${n} selected from the library`)), previewBox, ...rows,
      el('div', 'ci-end near', add, el('p', 'ci-hint', 'Added to the draft under New. Nothing is written to BMP until you save.'),
        el('div', 'ci-end-row', btn('ci-link quiet', undefined, () => { select(items, false); h.changed(); }, 'Clear selection')))];
  }

  function idlePanel(): HTMLElement[] {
    return [el('div', 'ci-ph', libraryIcon(), el('span', 'ci-title', 'Add from the library')),
      el('p', 'ci-hint', 'Select images, or a whole group with Select all. Then add them to a BMP folder, or drag them onto a folder on the left.'),
      el('p', 'ci-hint ci-hint-gap', 'They are added to the draft under New, where you can still adjust them. Nothing is written to BMP until you save.')];
  }

  function addSelected(folderId = destination()): void {
    if (h.cannotAdd() || !folderId) return;
    const picks = selectedItems().map(item => ({ item, variant: variant[item.collection], description: collection(item.collection)?.description ?? '' }));
    if (!picks.length) return;
    const files = libraryFiles(picks, color);
    select(selectedItems(), false);
    picked = null;
    h.onAdd(files, folderId);
  }

  return {
    load,
    side,
    view,
    search,
    panel,
    idlePanel,
    hasSelection: () => selection.size > 0,
    clearSelection() { if (selection.size) select(selectedItems(), false); },
    resetDestination() { picked = null; },
    destination,
  };
}
