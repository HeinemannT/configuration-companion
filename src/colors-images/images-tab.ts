/**
 * The Images tab. The sidebar is one tree drawn like Browse's: All images,
 * then the folders of the workspace that hold image files (nested as they are
 * in BMP, foldable, with counts), and below a rule the Library, ready-made
 * images that are not in BMP until added (library.ts). The main area shows a
 * folder's images as tiles, or a library collection under a strip that says
 * where additions go; one search finds both ("Images" and "Library").
 * An Adjust panel on the right with a preview: color (original, one color,
 * or swap single colors of an SVG), size, padding, format; behind More: turn, a shape behind the icon, line
 * width (line icons), trim. A selected image's file can be replaced; it
 * keeps its ID. Drop files or a folder, or use "Upload files" or "Upload
 * folder" (every image in it and its subfolders), or add library images to
 * a folder: new files appear under New with IDs proposed from their names,
 * and a description (a library icon's licence note) that is written with
 * them. The save bar (common.ts) counts what a save adds or changes and lists
 * it on Review; the write is previewed on the server, and a fresh read checks
 * it. A save that stops part way says which files went through; Save again
 * sends only the rest. File content is read only for the thumbnails in view
 * and for the images the person selects.
 */
import { attrs, btn, el, icon } from '../lib/dom';
import { normalizeHex } from '../lib/colors-images/color-math';
import {
  buildImageTree, EXTENSION_OF_MIME, folderPath, imageMime, imagesIn, totalImages, type FolderNode, type ImageFile, type ImageIndex,
} from '../lib/colors-images/image-files';
import {
  buildFileOps, defaultDestination, DESCRIPTION_LIMIT, idProblem, isOverLimit, newImagesFor, outputName, overLimitText, reproposeId, verifyFiles, type NewImage,
} from '../lib/colors-images/images-draft';
import {
  bytesToBase64, changesDrawing, DEFAULT_ADJUST, processImage, SIZES, type AdjustSettings, type ImageOutput, type ShapeKind,
} from '../lib/colors-images/image-process';
import { CURRENT_COLOR, hasStrokes, LINE_WIDTHS, svgColors } from '../lib/colors-images/svg-colors';
import { flip, isTurned, NO_TURN, rotateBy, type Turn } from '../lib/colors-images/svg-geometry';
import { encodeContent } from '../lib/colors-images/content-encoding';
import { tooLargeText, type FileOp } from '../lib/colors-images/write-ops';
import { ThumbCache, type ThumbState } from '../lib/colors-images/thumb-cache';
import { colorSuffix, WHITE, type CollectionId } from '../lib/colors-images/image-library';
import type { ColorSetData } from '../lib/types';
import { readColors, readImageBytes, readImages, writeChanges } from './api';
import { closeColorPop, openColorPop } from './color-pop';
import { createSaveBar, readFoot, saveFailure, statusBlock, treeRow, type ConfirmRow, type PageCtx, type SaveFailure } from './common';
import { filesFromDrop, filesFromFolder, filesFromInput, type PickedFile } from './dropped-files';
import { createLibrary } from './library';
import { pageIcon } from './icons';
import type { Tab } from './colors-tab';

type Format = 'auto' | 'svg' | 'png';
interface Settings {
  color: { mode: 'original' | 'one' | 'swap'; hex: string; map: Record<string, string> };
  size: AdjustSettings['size']; padding: number; format: Format;
  turn: Turn; trim: boolean; shape: { kind: ShapeKind; hex: string }; line: number | 'keep';
}

const defaults = (): Settings => ({
  color: { mode: 'original', hex: DEFAULT_ADJUST.color.hex, map: {} }, size: 'keep', padding: 0, format: 'auto',
  turn: NO_TURN, trim: false, shape: { kind: 'none', hex: '#E8E8E8' }, line: 'keep',
});

/** At most this many colors are offered to swap (across the selected SVGs). */
const SWAP_LIMIT = 8;

interface Made { sig: string; promise: Promise<ImageOutput>; out?: ImageOutput; url?: string; error?: string }
interface Source { bytes: Uint8Array; mime: string }
interface SvgInfo { colors: string[]; strokes: boolean }

const isSvgMime = (mime: string) => mime === 'image/svg+xml';
const kb = (n: number) => `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`;

export function createImagesTab(ctx: PageCtx): Tab & { selectFolder(id: string | null): void } {
  let index: ImageIndex | null = null;
  let tree: FolderNode[] = [];
  let fetchedAt: number | null = null;
  let loadError = '';
  let loading = false;
  let selFolder: string | null = null;
  /** The BMP folder the person last chose in the sidebar (null: All images); additions from the library go there by default. */
  let userFolder: string | null = null;
  /** The library collection shown in the main area, or null for the BMP folders. */
  let libView: CollectionId | null = null;
  /** The group of the collection to scroll to once it is drawn. */
  let libGroup: string | null = null;
  /** Says what the last addition from the library did ("3 images added to Status. …"). */
  let addedNote = '';
  let scrollToTop = false;
  let query = '';
  let news: NewImage[] = [];
  let selection = new Set<string>();
  let settings: Settings = defaults();
  let moreOpen = false;
  let counter = 0;
  /** While a save runs: the write, then the fresh read that checks it. */
  let phase: 'saving' | 'checking' | null = null;
  /** The last save that did not go through, and BMP's message for the file it stopped at. */
  let saveFailed: (SaveFailure & { failedId?: string; rowMessage?: string }) | null = null;
  /** Operations a save that stopped part way did write (as sent): Save again does not send them twice. */
  const writtenOps = new Map<string, string>();
  /** BMP folders folded in the sidebar. */
  const folded = new Set<string>();
  let result = '';
  let resultBad = false;
  let note = '';
  let preparing = 0;
  let holding = false;
  let colorSets: ColorSetData[] | null = null;
  let colorSetsLoading: Promise<void> | null = null;
  const made = new Map<string, Made>();
  const objectUrls = new Map<string, string>();
  /** Files chosen to replace an existing image's file, by RID. */
  const replaced = new Map<string, Source & { fileName: string }>();
  /** The bytes of selected existing images, once read. */
  const sources = new Map<string, Source>();
  const svgInfo = new Map<string, SvgInfo>();

  const thumbs = new ThumbCache(async rids => readImageBytes(rids));
  const side = el('div', 'ci-side');
  const main = el('div', 'ci-main');
  const panel = el('div', 'ci-panel');
  const root = el('div', 'ci-view ci-images', side, main, panel);
  root.hidden = true;
  const bar = createSaveBar(root);
  root.append(bar.el);
  const fileInput = attrs(el('input') as HTMLInputElement, { type: 'file', multiple: '', accept: 'image/*', hidden: '' });
  const replaceInput = attrs(el('input') as HTMLInputElement, { type: 'file', accept: 'image/*', hidden: '' });
  // A directory input: no permission needed, the browser asks the person for the folder.
  const folderInput = attrs(el('input') as HTMLInputElement, { type: 'file', webkitdirectory: '', multiple: '', hidden: '', 'aria-label': 'Upload folder' });
  root.append(fileInput, replaceInput, folderInput);
  const library = createLibrary({
    host: root,
    cannotAdd: () => (index ? null : loading ? 'The images are being read' : 'The images were not read'),
    colorSets: () => colorSets,
    needColorSets,
    folderSelect,
    folderName: id => index?.folders.find(f => f.id === id)?.name ?? '',
    defaultDestination: kind => (index ? defaultDestination(index, userFolder, kind, sideOrder()) : ''),
    onAdd: (files, folderId) => addFromLibrary(files, folderId),
    changed: () => { drawSide(); drawGrid(); drawPanel(); },
    folderAt: (x, y) => (document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-folder]')?.dataset.dropFolder ?? null),
    dropHint: (over, dragging) => {
      root.classList.toggle('lib-dragging', dragging);
      for (const r of side.querySelectorAll<HTMLElement>('[data-drop-folder]')) r.classList.toggle('drop-on', r.dataset.dropFolder === over);
    },
  });

  const existing = (rid: string): ImageFile | undefined => index?.files.find(f => f.rid === rid);
  const newItem = (key: string): NewImage | undefined => news.find(n => n.key === key);
  const unsaved = () => news.length > 0 || changedExisting().length > 0;

  // ── data ──────────────────────────────────────────────────────────

  async function load(force: boolean): Promise<void> {
    if (loading) return;
    loading = true; loadError = '';
    drawAll();
    try {
      const r = await ctx.work(readImages(force));
      index = { folders: r.folders, files: r.files };
      tree = buildImageTree(index);
      fetchedAt = r.fetchedAt;
      if (r.error) loadError = `Showing the list read earlier. ${r.error}`;
      if (force) { thumbs.clear(); sources.clear(); svgInfo.clear(); }
      if (selFolder !== null && !folderPath(index, selFolder)) selFolder = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      drawAll();
    }
  }

  /** The workspace's colors, for the swatches of the color popover (the copy read for the Colors tab). */
  function needColorSets(onReady: () => void): void {
    if (colorSets) return;
    colorSetsLoading ??= ctx.work(readColors(false)).then(r => { colorSets = r.sets; }, () => { colorSets = []; });
    void colorSetsLoading.then(onReady);
  }

  // ── what the settings do to a file ────────────────────────────────

  const mimeOfName = (name: string): string => imageMime(name) ?? 'image/png';

  /** The type an image is read as: a replaced file's, or its own. */
  function sourceMime(key: string): string {
    const n = newItem(key);
    if (n) return n.mime;
    return replaced.get(key)?.mime ?? mimeOfName(existing(key)?.name ?? '');
  }

  /** The format written for a file of this type: an SVG stays an SVG (BMP draws it on a button) unless PNG is chosen; a picture is PNG when adjusted. */
  function formatFor(mime: string): 'svg' | 'png' {
    if (!isSvgMime(mime)) return 'png';
    if (settings.format !== 'auto') return settings.format;
    return 'svg';
  }

  function adjustFor(mime: string): AdjustSettings {
    const s = settings;
    return {
      color: { mode: s.color.mode, hex: s.color.hex, map: s.color.map }, size: s.size, padding: s.padding, format: formatFor(mime),
      turn: s.turn, trim: s.trim, shape: s.shape, line: s.line,
    };
  }

  /** Does the person's choice change this existing file at all? Trim alone does not when it left the drawing as it was. */
  function touches(file: ImageFile): boolean {
    if (replaced.has(file.rid)) return true;
    const mime = sourceMime(file.rid);
    if (isSvgMime(mime) && settings.format === 'png') return true;
    const adjust = adjustFor(mime);
    if (!changesDrawing(adjust)) return false;
    const trimOnly = adjust.trim && !changesDrawing({ ...adjust, trim: false });
    return !(trimOnly && made.get(file.rid)?.out?.trimSkipped);
  }

  function sigOf(a: AdjustSettings, key: string): string {
    return JSON.stringify([a, replaced.has(key) ? replaced.get(key)!.fileName : '']);
  }

  /** Start (or reuse) the processing of one source under the current settings. */
  function make(key: string, source: Source): Made {
    const adjust = adjustFor(source.mime);
    const sig = sigOf(adjust, key);
    const old = made.get(key);
    if (old && old.sig === sig) return old;
    if (old?.url) URL.revokeObjectURL(old.url);
    preparing += 1;
    const entry: Made = { sig, promise: Promise.resolve(null as unknown as ImageOutput) };
    entry.promise = processImage(source, adjust).then(async out => {
      out.base64 = await encodeContent(out.bytes);
      if (made.get(key) !== entry) return out;
      entry.out = out;
      entry.url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: out.mime }));
      return out;
    }, e => {
      entry.error = e instanceof Error ? e.message : String(e);
      throw e;
    }).finally(() => { preparing -= 1; schedule(); });
    entry.promise.catch(() => undefined);
    made.set(key, entry);
    return entry;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Redraw what depends on processed results, once they settle. */
  function schedule(): void {
    clearTimeout(timer);
    timer = setTimeout(() => { drawSide(); drawGrid(); drawPreview(); drawBar(); }, 40);
  }

  /** Why the file as it would be written does not fit one write (its size and the limit), or null.
   *  A file already in the workspace counts only while the settings change it. */
  function overText(key: string): string | null {
    const m = made.get(key);
    if (!m?.out) return null;
    const out = m.out;
    const base64 = out.base64 ?? bytesToBase64(out.bytes);
    const n = newItem(key);
    if (n) return isOverLimit({ item: n }, out, bytesToBase64) ? overLimitText(outputName(n.fileName, out.mime), base64) : null;
    const f = existing(key);
    if (!f || !selection.has(key) || !touches(f)) return null;
    return isOverLimit({ file: f }, out, bytesToBase64) ? overLimitText(outputName(f.name, out.mime), base64) : null;
  }

  /** Existing files the current settings change. */
  function changedExisting(): ImageFile[] {
    if (!index) return [];
    return [...selection].map(existing).filter((f): f is ImageFile => !!f && touches(f));
  }

  /** The bytes of a selected image as it is now (or as replaced). */
  function sourceOf(key: string): Source | undefined {
    const n = newItem(key);
    if (n) return { bytes: n.bytes, mime: n.mime };
    return replaced.get(key) ?? sources.get(key);
  }

  function learn(key: string, src: Source): void {
    if (svgInfo.has(key) || !isSvgMime(src.mime)) return;
    try {
      const doc = new DOMParser().parseFromString(new TextDecoder().decode(src.bytes), 'image/svg+xml');
      const svg = doc.documentElement;
      if (doc.querySelector('parsererror') || svg.localName !== 'svg') return;
      svgInfo.set(key, { colors: svgColors(svg).map(c => c.key), strokes: hasStrokes(svg) });
    } catch { /* not an SVG after all: no colors to offer */ }
  }

  /** Read what the selection needs (bytes of selected images), then produce outputs for new and changed ones. */
  function prepare(): void {
    for (const n of news) { learn(n.key, { bytes: n.bytes, mime: n.mime }); make(n.key, { bytes: n.bytes, mime: n.mime }); }
    for (const key of selection) {
      const f = existing(key);
      if (!f) continue;
      const known = sourceOf(key);
      if (known) {
        learn(key, known);
        if (touches(f)) make(key, known);
        continue;
      }
      void thumbs.bytes(f.rid, f.name).then(t => {
        const src = { bytes: t.bytes, mime: t.mime };
        sources.set(f.rid, src);
        learn(f.rid, src);
        if (selection.has(f.rid) && touches(f)) make(f.rid, sourceOf(f.rid)!);
        drawPanel(); schedule();
      }, () => schedule());
    }
  }

  // ── the folders ───────────────────────────────────────────────────

  /** The folders in the order the sidebar lists them (those that hold images, nested). */
  function sideOrder(): string[] {
    const out: string[] = [];
    const walk = (nodes: FolderNode[]) => { for (const n of nodes) { out.push(n.id); walk(n.children); } };
    walk(tree);
    return out;
  }

  /** Unfold the folders that hold this one, so it shows in the sidebar. */
  function reveal(id: string | null): void {
    let at = id ? index?.folders.find(f => f.id === id)?.parentId : undefined;
    for (let guard = 0; at && guard < 64; guard++) { folded.delete(at); at = index?.folders.find(f => f.id === at)?.parentId; }
  }

  /** Show a BMP folder (null: all images); leaves the library and the search. */
  function openFolder(id: string | null): void {
    selFolder = id; userFolder = id; libView = null; query = ''; addedNote = '';
    library.clearSelection();
    library.resetDestination();
    scrollToTop = true;
    drawAll();
  }

  /** Show a library collection (and scroll to one of its groups). */
  function openCollection(id: CollectionId, group?: string): void {
    libView = id; query = ''; addedNote = '';
    libGroup = group ?? null;
    scrollToTop = !group;
    library.load();
    drawAll();
  }

  function drawSide(): void {
    const list = el('div', 'ci-side-list');
    // The folders of the workspace need no heading: the tree starts with All images.
    const bmp = attrs(el('section', 'ci-sec bmp'), { 'aria-label': 'Image folders' });
    if (index) {
      // Folders that only hold new images (a library image added to an empty folder) are listed too.
      const withNew = news.length ? buildImageTree({ folders: index.folders, files: [...index.files, ...news.map(n => ({ rid: n.key, id: n.id, name: n.fileName, folderId: n.folderId }))] }) : tree;
      const real = new Map<string, number>();
      const count = (nodes: FolderNode[]) => { for (const n of nodes) { real.set(n.id, n.count); count(n.children); } };
      count(tree);
      const newMark = (nNew: number) => (nNew ? attrs(el('span', 'ci-newn', `+${nNew}`), { title: `${nNew} new, not saved yet` }) : null);
      bmp.append(treeRow({
        label: 'All images', depth: 0, glyph: 'o-image', count: totalImages(tree), on: !libView && selFolder === null,
        extra: newMark(news.length), onOpen: () => openFolder(null),
      }));
      const walk = (nodes: FolderNode[], depth: number) => {
        for (const n of nodes) {
          const kids = n.children.length > 0;
          const open = kids && !folded.has(n.id);
          const row = treeRow({
            label: n.name, depth, glyph: 'o-folder', count: real.get(n.id) ?? 0, on: !libView && selFolder === n.id,
            ...(kids ? { expanded: open, onToggle: () => { if (folded.has(n.id)) folded.delete(n.id); else folded.add(n.id); drawSide(); } } : {}),
            extra: newMark(n.count - (real.get(n.id) ?? 0)), title: folderPath(index!, n.id), onOpen: () => openFolder(n.id),
          });
          row.dataset.dropFolder = n.id;
          bmp.append(row);
          if (open) walk(n.children, depth + 1);
        }
      };
      walk(withNew, 0);
      if (!withNew.length) bmp.append(el('p', 'ci-sec-cap', 'No images yet.'));
    } else if (loading) {
      bmp.append(...[72, 56, 64].map(w => attrs(el('div', 'ci-skel-row'), { style: `width:${w}%` })));
    }
    list.append(bmp, library.side(libView, (id, group) => openCollection(id, group)));
    const top = side.querySelector('.ci-side-list')?.scrollTop ?? 0;
    side.replaceChildren(list, readFoot(fetchedAt, () => { void load(true); }, unsaved() ? 'Save or cancel the changes first' : undefined, loading));
    list.scrollTop = top;
  }

  // ── the images ────────────────────────────────────────────────────

  function targetFolder(): string {
    if (selFolder) return selFolder;
    if (!index) return '';
    // With all images shown: the folder that holds the most of them.
    const counts = new Map<string, number>();
    for (const f of index.files) counts.set(f.folderId, (counts.get(f.folderId) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? index.folders[0]?.id ?? '';
  }

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { observer?.unobserve(e.target); (e.target as HTMLElement & { _load?: () => void })._load?.(); }
    }, { rootMargin: '200px' })
    : null;

  function thumbBox(rid: string, name: string): HTMLElement {
    const box = el('div', 'ci-thumb');
    const show = (s: ThumbState) => {
      if (s.state === 'ready') box.replaceChildren(attrs(el('img'), { src: s.url, alt: '', draggable: 'false' }));
      else if (s.state === 'error') { box.replaceChildren(icon('i-warn', 'ic-sm')); box.title = s.error; }
    };
    (box as HTMLElement & { _load?: () => void })._load = () => { thumbs.want(rid, name, show); };
    const known = thumbs.peek(rid);
    if (known) show(known);
    else if (observer) observer.observe(box);
    else (box as HTMLElement & { _load?: () => void })._load?.();
    return box;
  }

  function toggle(key: string): void {
    if (selection.has(key)) selection.delete(key); else selection.add(key);
    result = ''; addedNote = '';
    library.clearSelection();
    closeColorPop();
    resetForSelection();
    prepare();
    drawAll();
  }

  function tile(key: string, name: string, id: string, thumb: HTMLElement, opts: { selected: boolean; badge?: string; idInput?: NewImage; over?: string | null; changed?: boolean }): HTMLElement {
    const t = el('div', `ci-itile${opts.selected ? ' on' : ''}`);
    const check = opts.selected ? el('span', 'ci-ck', icon('i-check', 'ic-sm')) : null;
    thumb.append(...[check, opts.over ? attrs(el('span', 'ci-over', 'Too large'), { title: opts.over }) : null,
      opts.changed ? attrs(el('span', 'ci-dot'), { title: 'Changed' }) : null,
      opts.badge ? el('span', 'ci-fmt', opts.badge) : null].filter((x): x is HTMLElement => !!x));
    const pick = btn('ci-itile-pick', `${name}, ${id}`, () => toggle(key), thumb);
    pick.setAttribute('aria-pressed', String(opts.selected));
    t.append(pick, attrs(el('div', 'ci-nm', name), { title: name }));
    const item = opts.idInput;
    if (item && index) {
      const input = attrs(el('input', 'ci-idin') as HTMLInputElement, { 'aria-label': `ID of ${name}`, spellcheck: 'false' });
      input.value = item.id;
      const problem = idProblem(item, index, news);
      if (problem) { input.setAttribute('aria-invalid', 'true'); input.title = problem; }
      input.addEventListener('input', () => {
        item.id = input.value.trim(); item.idTouched = true;
        const p = idProblem(item, index!, news);
        if (p) { input.setAttribute('aria-invalid', 'true'); input.title = p; } else { input.removeAttribute('aria-invalid'); input.title = ''; }
        drawBar();
      });
      t.append(input);
    } else t.append(attrs(el('div', 'ci-id', id), { title: id }));
    return t;
  }

  const badgeOf = (mime: string) => (EXTENSION_OF_MIME[mime] ?? 'png').toUpperCase();

  /** Is the image as it would be written white only (an icon for a dark button)? Its thumbnail is then dark. */
  function whiteOnly(key: string): boolean {
    const info = svgInfo.get(key);
    if (!info?.colors.length || !isSvgMime(sourceMime(key))) return false;
    const c = settings.color;
    if (selection.has(key) && c.mode === 'one') return c.hex === WHITE;
    const to = (k: string) => (selection.has(key) && c.mode === 'swap' ? c.map[k] ?? k : k);
    return info.colors.every(k => to(k) === WHITE);
  }

  function newTile(n: NewImage): HTMLElement {
    const m = made.get(n.key);
    const thumb = el('div', `ci-thumb${whiteOnly(n.key) ? ' on-dark' : ''}`);
    const url = m?.url ?? (objectUrls.get(n.key) ?? (() => { const u = URL.createObjectURL(new Blob([n.bytes as BlobPart], { type: n.mime })); objectUrls.set(n.key, u); return u; })());
    thumb.append(attrs(el('img'), { src: url, alt: '', draggable: 'false' }));
    const out = m?.out;
    return tile(n.key, outputName(n.fileName, out?.mime ?? n.mime), n.id, thumb, {
      selected: selection.has(n.key), badge: badgeOf(out?.mime ?? n.mime), idInput: n, over: overText(n.key),
    });
  }

  function fileTile(f: ImageFile): HTMLElement {
    const thumb = thumbBox(f.rid, f.name);
    const m = made.get(f.rid);
    const changed = selection.has(f.rid) && touches(f);
    if (m?.url && changed) thumb.replaceChildren(attrs(el('img'), { src: m.url, alt: '', draggable: 'false' }));
    const ext = (f.name.split('.').pop() ?? '').toUpperCase();
    return tile(f.rid, f.name, f.id, thumb, { over: overText(f.rid), selected: selection.has(f.rid), badge: changed && m?.out ? badgeOf(m.out.mime) : ext, changed });
  }

  function dropTile(): HTMLElement {
    return btn('ci-itile drop', 'Upload files', () => fileInput.click(), el('div', 'ci-thumb', pageIcon('upload')), el('div', 'ci-nm muted', 'Drop files here'));
  }

  function group(title: string, count: number, tiles: HTMLElement[]): HTMLElement {
    return el('section', 'ci-group', el('div', 'ci-ghead', title, el('span', 'ci-gn', String(count))), el('div', 'ci-igrid', ...tiles));
  }

  function emptyBlock(title: string, withAdd: boolean): HTMLElement {
    return el('div', 'ci-empty', el('div', 'ci-empty-t', title),
      withAdd ? el('div', 'ci-empty-s', 'Drop files or a folder here, or add ready-made images from the library.') : null,
      withAdd ? el('div', 'ci-inl', btn('ui-btn', undefined, () => fileInput.click(), pageIcon('upload'), 'Upload files'),
        btn('ui-btn', undefined, () => openCollection('status'), icon('o-library'), 'Browse the library')) : null);
  }

  /** The search box and the uploads, over every view. */
  function mainHead(): HTMLElement {
    const input = attrs(el('input', 'ci-inp') as HTMLInputElement, { placeholder: 'Search BMP and the library', 'aria-label': 'Search images in BMP and the library' });
    input.value = query;
    input.addEventListener('input', () => {
      query = input.value; result = ''; addedNote = '';
      if (query.trim()) library.load();
      scrollToTop = true;
      drawGrid(); drawSide(); drawPanel();
      const i = main.querySelector<HTMLInputElement>('.ci-search input');
      i?.focus(); i?.setSelectionRange(query.length, query.length);
    });
    const clear = query ? btn('ci-ib', 'Clear the search', () => { query = ''; scrollToTop = true; drawAll(); main.querySelector<HTMLInputElement>('.ci-search input')?.focus(); }, icon('i-x', 'ic-sm')) : null;
    return el('div', 'ci-mhead', el('div', 'ci-search ui-search', icon('i-search', 'ic-sm'), input, clear),
      attrs(btn('ui-btn ci-add ci-upfiles', undefined, () => fileInput.click(), pageIcon('upload'), el('span', 'ci-add-t', 'Upload files')), { title: 'Upload image files from this computer' }),
      attrs(btn('ui-btn ci-add ci-folder', undefined, () => folderInput.click(), pageIcon('folderUp'), el('span', 'ci-add-t', 'Upload folder')), { title: 'Upload every image of a folder on this computer' }));
  }

  /** The BMP part of a search: matches by name or ID, or that there is none. */
  function bmpMatches(q: string): HTMLElement {
    const hits = index!.files.filter(f => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
    return el('section', 'ci-sres bmp',
      el('div', 'ci-shead', icon('o-folder'), el('span', '', 'Images'), el('span', 'ci-gn', String(hits.length))),
      hits.length ? el('div', 'ci-igrid', ...hits.map(fileTile)) : el('p', 'ci-nomatch', `No image matches “${query.trim()}”.`));
  }

  function drawGrid(): void {
    const scroll = main.querySelector<HTMLElement>('.ci-scroll');
    const top = scrollToTop ? 0 : scroll?.scrollTop ?? 0;
    scrollToTop = false;
    const body = el('div', 'ci-scroll');
    if (!index) {
      if (loading) {
        main.replaceChildren(el('div', 'ci-mhead', el('div', 'ci-skel-bar')), el('div', 'ci-scroll', el('div', 'ci-igrid', ...Array.from({ length: 10 }, () => el('div', 'ci-itile skel', el('div', 'ci-thumb'), el('div', 'ci-skel-row'), attrs(el('div', 'ci-skel-row'), { style: 'width:60%' }))))));
      } else main.replaceChildren(statusBlock(loadError || 'The images were not read.', () => { void load(true); }));
      return;
    }
    const groups: HTMLElement[] = [];
    const q = query.trim().toLowerCase();
    if (news.length && !(libView && !q)) groups.push(group('New', news.length, [...news.map(newTile), dropTile()]));
    if (q) {
      groups.push(bmpMatches(q), library.search(query));
    } else if (libView) {
      groups.push(...library.view(libView));
    } else {
      const shown = imagesIn(index, tree, selFolder);
      const byFolder = new Map<string, ImageFile[]>();
      for (const f of shown) byFolder.set(f.folderId, [...(byFolder.get(f.folderId) ?? []), f]);
      const order = [...byFolder.keys()].sort((a, b) => folderPath(index!, a).localeCompare(folderPath(index!, b), undefined, { numeric: true }));
      for (const id of order) {
        const files = byFolder.get(id)!;
        const leaf = index.folders.find(f => f.id === id)?.name ?? id;
        groups.push(group(leaf, files.length, files.map(fileTile)));
      }
      if (!groups.length) groups.push(emptyBlock(index.files.length ? 'No images in this folder' : 'No images yet', true));
      else if (!news.length) groups[0].querySelector('.ci-igrid')?.append(dropTile());
    }
    body.append(...groups);
    const notes = [loadError ? el('span', 'ci-warn', loadError) : null, note ? el('span', 'ci-warn', note) : null,
      addedNote ? el('span', 'ci-result ci-added', icon('i-check', 'ic-sm'), el('span', '', addedNote)) : null,
      result ? el('span', `ci-result${resultBad ? ' bad' : ''}`, result) : null].filter((x): x is HTMLElement => !!x);
    main.replaceChildren(mainHead(), notes.length ? el('div', 'ci-notes', ...notes) : '', body);
    body.scrollTop = top;
    if (libGroup && libView && !q) {
      const g = body.querySelector<HTMLElement>(`[data-group="${CSS.escape(libGroup)}"]`);
      if (g) { body.scrollTop = Math.max(0, g.offsetTop - body.offsetTop - 8); libGroup = null; }
    }
    const q2 = main.querySelector<HTMLInputElement>('.ci-search input');
    if (q2 && document.activeElement === document.body && query) { /* keep the caret where the person was typing */ q2.focus(); q2.setSelectionRange(query.length, query.length); }
  }

  // ── Adjust ────────────────────────────────────────────────────────

  const selectedKeys = () => [...selection];
  const allSvg = () => selectedKeys().every(k => isSvgMime(sourceMime(k)));

  /** The format segment shows what would be written for the selection. */
  function shownFormat(): 'svg' | 'png' | null {
    if (settings.format !== 'auto') return settings.format;
    const svg = selectedKeys().filter(k => isSvgMime(sourceMime(k))).length;
    // A mix stays as each file is (an SVG stays an SVG, a picture becomes PNG when changed): neither is pressed.
    return svg === selection.size ? 'svg' : svg === 0 ? 'png' : null;
  }

  /** An empty selection starts again from the defaults. */
  function resetForSelection(): void {
    if (selection.size === 0) { settings = defaults(); syncIds(); }
  }

  /** The colors to swap: of one SVG, or the union of several (at most SWAP_LIMIT); null when not offered. */
  function swapColors(): { colors: string[]; why?: string } {
    if (!allSvg()) return { colors: [], why: 'SVG files only' };
    const all: string[] = [];
    for (const k of selectedKeys()) {
      const info = svgInfo.get(k);
      if (!info) continue;
      for (const c of info.colors) if (!all.includes(c)) all.push(c);
    }
    if (all.length > SWAP_LIMIT) return { colors: [], why: `More than ${SWAP_LIMIT} colors` };
    return { colors: all };
  }

  function segment<T extends string | number>(label: string, options: Array<{ value: T; text?: string; icon?: Node; disabled?: boolean; title?: string }>, current: T | null, set: (v: T) => void, cls = ''): HTMLElement {
    const group = attrs(el('span', `ci-seg${cls ? ` ${cls}` : ''}`), { role: 'group', 'aria-label': label });
    for (const o of options) {
      const b = btn(o.value === current ? 'on' : '', o.icon ? (o.title ?? o.text) : undefined, () => { if (!o.disabled) set(o.value); }, o.icon ?? o.text ?? '');
      b.setAttribute('aria-pressed', String(o.value === current));
      if (o.title) b.title = o.title;
      if (o.disabled) b.disabled = true;
      group.append(b);
    }
    return group;
  }

  const previewBox = el('div', 'ci-preview');
  const overBox = el('div', 'ci-over-note');

  /** The images as they were: the thumbnail, the new file, or the file before it was replaced. */
  function beforeUrl(key: string): string | undefined {
    const n = newItem(key);
    if (n) return objectUrls.get(key) ?? (() => { const u = URL.createObjectURL(new Blob([n.bytes as BlobPart], { type: n.mime })); objectUrls.set(key, u); return u; })();
    const t = thumbs.peek(key);
    return t?.state === 'ready' ? t.url : undefined;
  }

  function drawPreview(): void {
    overBox.replaceChildren(...selectedKeys().map(overText).filter((t): t is string => !!t).map(t => el('p', 'ci-warn', t)));
    const keys = selectedKeys().slice(0, 4);
    const imgs: Node[] = [];
    let before = 0, after = 0, anyChange = false, ready = true, trimSkipped = false;
    for (const k of selectedKeys()) {
      const file = existing(k);
      const changed = !file || touches(file);
      const m = made.get(k);
      const src = sourceOf(k);
      if (m?.out?.trimSkipped && settings.trim) trimSkipped = true;
      if (!changed) continue;
      anyChange = true;
      if (m?.out && src) { before += (file ? (sources.get(k)?.bytes.length ?? src.bytes.length) : src.bytes.length); after += m.out.bytes.length; } else ready = false;
    }
    for (const k of keys) {
      const m = made.get(k);
      const file = existing(k);
      const changed = !file || touches(file);
      const shownUrl = holding || !changed ? beforeUrl(k) : m?.url;
      if (shownUrl) imgs.push(attrs(el('img'), { src: shownUrl, alt: '' }));
      else if (m?.error) imgs.push(el('span', 'ci-warn', 'Cannot adjust'));
      else imgs.push(el('span', 'ci-spin'));
    }
    const holdBtn = anyChange ? btn('ci-before', undefined, () => undefined, 'Hold to see before') : null;
    if (holdBtn) {
      const down = (e: PointerEvent) => { e.preventDefault(); holding = true; holdBtn.setPointerCapture(e.pointerId); drawPreview(); };
      const up = () => { if (!holding) return; holding = false; drawPreview(); };
      holdBtn.addEventListener('pointerdown', down);
      holdBtn.addEventListener('pointerup', up);
      holdBtn.addEventListener('pointercancel', up);
      holdBtn.classList.toggle('on', holding);
    }
    const sizeLine = anyChange && ready && before > 0 ? el('span', 'ci-pv-size', `${kb(before)} → ${kb(after)}`) : null;
    previewBox.replaceChildren(el('div', 'ci-pv-imgs', ...imgs), sizeLine ?? '', holdBtn ?? '');
    previewBox.classList.toggle('many', keys.length > 1);
    previewBox.classList.toggle('on-dark', keys.length > 0 && keys.every(whiteOnly));
    previewBox.classList.toggle('before', holding);
    const trimNote = panel.querySelector<HTMLElement>('.ci-trim-note');
    if (trimNote) trimNote.hidden = !(settings.trim && trimSkipped);
  }

  function changeSettings(next: Partial<Settings>, redrawPanel = true): void {
    settings = { ...settings, ...next };
    if (next.color) syncIds();
    result = '';
    prepare();
    if (redrawPanel) drawPanel(); else drawPreview();
    drawSide();
    drawGrid();
    drawBar();
  }

  function colorChip(hex: string, label: string, onPick: (hex: string) => void, original?: string, text?: string, cls = ''): HTMLButtonElement {
    const b = btn(`ci-cchip${cls ? ` ${cls}` : ''}`, label, () => {
      if (b.getAttribute('aria-expanded') === 'true') { closeColorPop(); return; }
      const pop = openColorPop({ anchor: b, host: root, value: hex, sets: colorSets, ...(original ? { original } : {}), onPick });
      needColorSets(() => pop.setSets(colorSets));
    }, attrs(el('i'), { style: `background:${hex}` }), text ? el('span', '', text) : null);
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-expanded', 'false');
    return b;
  }

  function moreCount(): number {
    const s = settings;
    return (isTurned(s.turn) ? 1 : 0) + (s.trim ? 1 : 0) + (s.shape.kind !== 'none' ? 1 : 0) + (s.line !== 'keep' ? 1 : 0);
  }

  /** A picker of the BMP folders, by path: where new images go. */
  function folderSelect(current: string, onChange: (id: string) => void, label: string): HTMLSelectElement {
    const sel = attrs(el('select', 'ci-select') as HTMLSelectElement, { 'aria-label': label });
    if (!index) return sel;
    const options = index.folders.map(f => ({ id: f.id, path: folderPath(index!, f.id) })).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    for (const o of options) {
      const opt = el('option', '', o.path) as HTMLOptionElement;
      opt.value = o.id; opt.selected = o.id === current;
      sel.append(opt);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  /** The colour the Adjust panel paints new images in, as an ID ends with it; undefined when it sets none. */
  const adjustSuffix = (): string | undefined => (settings.color.mode === 'one' ? colorSuffix(settings.color) : undefined);

  /** Proposed IDs follow the folder and, for library images, the colour they are written in. A typed ID stays. */
  function syncIds(): void {
    if (!index) return;
    const hex = adjustSuffix();
    for (const n of news) if (!n.idTouched) n.id = reproposeId(n, index, news, n.library ? hex : undefined);
  }

  function drawPanel(): void {
    if (!index) { panel.replaceChildren(); return; }
    const fromLibrary = library.panel();
    if (fromLibrary) { panel.replaceChildren(...fromLibrary); return; }
    if (libView && !query.trim() && selection.size === 0) { panel.replaceChildren(...library.idlePanel()); return; }
    const keys = selectedKeys();
    const n = keys.length;
    if (!n) {
      panel.replaceChildren(el('div', 'ci-ph', el('span', 'ci-title', 'Adjust')),
        el('p', 'ci-hint', 'Select one or more images.'));
      return;
    }
    const one = n === 1 ? keys[0] : null;
    const oneFile = one ? existing(one) : undefined;
    const oneNew = one ? newItem(one) : undefined;
    const svgOnly = allSvg();
    const info = keys.map(k => svgInfo.get(k));
    const lineIcons = svgOnly && info.every(i => i?.strokes);

    // The header: the file and its ID, or the count.
    const head = one
      ? el('div', 'ci-ph two', attrs(el('span', 'ci-title', oneNew ? outputName(oneNew.fileName, made.get(one)?.out?.mime ?? oneNew.mime) : oneFile?.name ?? ''), { title: oneFile?.name ?? '' }),
        el('span', 'ci-id', oneNew ? `New in ${folderPath(index, oneNew.folderId) || oneNew.folderId}` : oneFile?.id ?? ''))
      : el('div', 'ci-ph', el('span', 'ci-title', `Adjust ${n} images`));

    const rows: Array<HTMLElement | null> = [];
    const swap = swapColors();
    rows.push(el('div', 'ci-prop', el('span', '', 'Color'),
      segment('Color', [
        { value: 'original', text: 'Original' }, { value: 'one', text: 'One color' },
        { value: 'swap', text: 'Swap colors', disabled: !!swap.why, ...(swap.why ? { title: swap.why } : {}) },
      ], settings.color.mode, v => changeSettings({ color: { ...settings.color, mode: v } }))));
    if (settings.color.mode === 'one') {
      const hexInput = attrs(el('input', 'ci-inp mono') as HTMLInputElement, { 'aria-label': 'Color', spellcheck: 'false', maxlength: '7' });
      hexInput.value = settings.color.hex;
      const chip = colorChip(settings.color.hex, 'Choose a color', hex => {
        hexInput.value = hex; hexInput.removeAttribute('aria-invalid');
        chip.querySelector('i')!.setAttribute('style', `background:${hex}`);
        changeSettings({ color: { ...settings.color, mode: 'one', hex } }, false);
      });
      hexInput.addEventListener('input', () => {
        const v = normalizeHex(hexInput.value);
        if (!v) { hexInput.setAttribute('aria-invalid', 'true'); return; }
        hexInput.removeAttribute('aria-invalid');
        chip.querySelector('i')!.setAttribute('style', `background:${v}`);
        changeSettings({ color: { ...settings.color, mode: 'one', hex: v } }, false);
      });
      rows.push(el('div', 'ci-prop', el('span', ''), el('span', 'ci-inl', chip, hexInput)));
    } else if (settings.color.mode === 'swap') {
      const known = keys.every(k => svgInfo.has(k));
      const chips = swap.colors.map(c => {
        const to = settings.color.map[c];
        const shown = to ?? (c === CURRENT_COLOR ? '#000000' : c);
        const label = to ? to.slice(1) : c === CURRENT_COLOR ? 'Text color' : c.slice(1);
        const chip = colorChip(shown, `Swap ${c === CURRENT_COLOR ? 'the text color' : c}`, hex => {
          const map = { ...settings.color.map };
          const was = c === CURRENT_COLOR ? null : c;
          if (hex === was) delete map[c]; else map[c] = hex;
          changeSettings({ color: { ...settings.color, map } }, false);
          chip.querySelector('i')!.setAttribute('style', `background:${hex}`);
          chip.querySelector('span')!.textContent = hex === was ? c.slice(1) : hex.slice(1);
          chip.classList.toggle('chg', hex !== was);
        }, c === CURRENT_COLOR ? undefined : c, label);
        if (to) { chip.classList.add('chg'); chip.title = `${c === CURRENT_COLOR ? 'Text color' : c} → ${to}`; }
        return chip;
      });
      rows.push(el('div', 'ci-prop top', el('span', ''), known
        ? (chips.length ? el('div', 'ci-swaps', ...chips) : el('span', 'ci-hint', 'No colors to swap'))
        : el('span', 'ci-spin')));
    }
    const padding = attrs(el('input', 'ci-inp mono narrow') as HTMLInputElement, { 'aria-label': 'Padding in px', inputmode: 'numeric', maxlength: '2' });
    padding.value = String(settings.padding);
    padding.addEventListener('input', () => {
      const v = Math.min(12, Math.max(0, Math.round(Number(padding.value) || 0)));
      changeSettings({ padding: v }, false);
    });
    rows.push(
      el('div', 'ci-prop', el('span', '', 'Size'),
        segment<string>('Size', [{ value: 'keep', text: 'Keep' }, ...SIZES.map(s => ({ value: String(s), text: String(s) }))], String(settings.size), v => changeSettings({ size: v === 'keep' ? 'keep' : Number(v) }))),
      el('div', 'ci-prop', el('span', '', 'Padding'), el('span', 'ci-inl', padding, el('span', 'ci-unit', 'px'))),
      el('div', 'ci-prop', el('span', '', 'Format'),
        segment<'svg' | 'png'>('Format', [
          { value: 'svg', text: 'SVG', disabled: !keys.some(k => isSvgMime(sourceMime(k))), title: 'Only an SVG file can stay an SVG' },
          { value: 'png', text: 'PNG' },
        ], shownFormat(), v => changeSettings({ format: v }))),
    );
    const newSel = keys.map(newItem).filter((x): x is NewImage => !!x);
    if (newSel.length) {
      const sel = folderSelect(newSel[0].folderId, id => {
        for (const item of newSel) item.folderId = id;
        syncIds();
        drawAll();
      }, 'Folder for the new files');
      rows.push(el('div', 'ci-prop', el('span', '', 'Folder'), sel));
      // The description written with the new images: one for all selected, or each its own.
      const desc = attrs(el('input', 'ci-inp ci-desc') as HTMLInputElement, { 'aria-label': 'Description of the new files', maxlength: String(DESCRIPTION_LIMIT) });
      const same = newSel.every(x => x.description === newSel[0].description);
      desc.value = same ? newSel[0].description : '';
      desc.placeholder = same ? 'None' : 'Different for each';
      desc.title = same ? newSel[0].description : newSel.map(x => x.description).filter(Boolean).join(' / ');
      desc.addEventListener('input', () => {
        for (const item of newSel) item.description = desc.value;
        desc.placeholder = 'None';
        drawBar();
      });
      rows.push(el('div', 'ci-prop stack', el('span', '', 'Description'), desc));
    }

    // More: turn, shape, line width, trim.
    const count = moreCount();
    const moreBtn = btn(`ci-more${moreOpen ? ' open' : ''}`, undefined, () => { moreOpen = !moreOpen; drawPanel(); },
      icon(moreOpen ? 'i-chev' : 'i-right', 'ic-sm'), el('span', '', 'More'), count && !moreOpen ? el('span', 'ci-more-n', String(count)) : null);
    moreBtn.setAttribute('aria-expanded', String(moreOpen));
    rows.push(moreBtn);
    if (moreOpen) {
      const turnBtn = (name: 'rotl' | 'rotr' | 'fliph' | 'flipv', label: string, next: () => Turn) => {
        const b = btn('', label, () => changeSettings({ turn: next() }, false), pageIcon(name));
        b.title = label;
        return b;
      };
      const turns = attrs(el('span', 'ci-seg icons'), { role: 'group', 'aria-label': 'Turn' });
      turns.append(
        turnBtn('rotl', 'Rotate left', () => rotateBy(settings.turn, -1)), turnBtn('rotr', 'Rotate right', () => rotateBy(settings.turn, 1)),
        turnBtn('fliph', 'Flip horizontal', () => flip(settings.turn, 'h')), turnBtn('flipv', 'Flip vertical', () => flip(settings.turn, 'v')));
      rows.push(el('div', 'ci-prop', el('span', '', 'Turn'), el('span', 'ci-inl', turns,
        isTurned(settings.turn) ? btn('ci-ib', 'Undo turn', () => changeSettings({ turn: NO_TURN }), icon('i-undo')) : null)));
      rows.push(el('div', 'ci-prop', el('span', '', 'Shape'), el('span', 'ci-inl',
        segment<ShapeKind>('Shape', [
          { value: 'none', icon: pageIcon('none'), title: 'None' }, { value: 'circle', icon: pageIcon('circle'), title: 'Circle' }, { value: 'square', icon: pageIcon('square'), title: 'Rounded square' },
        ], settings.shape.kind, v => changeSettings({ shape: { ...settings.shape, kind: v } }), 'icons'),
        settings.shape.kind !== 'none' ? colorChip(settings.shape.hex, 'Shape color', hex => {
          panel.querySelector('.ci-shape-chip i')?.setAttribute('style', `background:${hex}`);
          changeSettings({ shape: { ...settings.shape, hex } }, false);
        }, undefined, undefined, 'ci-shape-chip') : null)));
      if (lineIcons) {
        rows.push(el('div', 'ci-prop', el('span', '', 'Line'),
          segment<string>('Line width', [{ value: 'keep', text: 'Keep' }, ...LINE_WIDTHS.map(w => ({ value: String(w), text: String(w) }))], String(settings.line), v => changeSettings({ line: v === 'keep' ? 'keep' : Number(v) }))));
      }
      const trim = attrs(el('input') as HTMLInputElement, { type: 'checkbox' });
      trim.checked = settings.trim;
      trim.addEventListener('change', () => changeSettings({ trim: trim.checked }, false));
      const trimNote = attrs(el('span', 'ci-trim-note', 'Kept as is'), { title: 'A mask, clip path, filter or text decides its outline' });
      trimNote.hidden = true;
      rows.push(el('div', 'ci-prop', el('span', ''), el('label', 'ci-trim', trim, el('span', '', 'Trim empty space'), trimNote)));
    }

    // The end: replace the file of one existing image, clear the selection.
    const rep = oneFile ? replaced.get(oneFile.rid) : undefined;
    const end = el('div', 'ci-end',
      rep ? el('div', 'ci-replaced', el('span', '', `Replaced with ${rep.fileName}`), btn('ci-link', undefined, () => { replaced.delete(oneFile!.rid); svgInfo.delete(oneFile!.rid); made.delete(oneFile!.rid); prepare(); drawAll(); }, 'Undo')) : null,
      el('div', 'ci-end-row',
        oneFile ? btn('ci-link', undefined, () => replaceInput.click(), 'Replace file') : null,
        btn('ci-link quiet', undefined, () => { selection = new Set(); settings = defaults(); syncIds(); closeColorPop(); drawAll(); }, 'Clear selection')));
    panel.replaceChildren(...[head, previewBox, overBox, ...rows, end].filter((x): x is HTMLElement => !!x));

    drawPreview();
  }

  // ── the save bar ──────────────────────────────────────────────────

  const opKey = (kind: 'add' | 'change', id: string) => `${kind}:${id}`;

  /** After a save that stopped part way: was this row written, is it the one BMP refused, or was it not reached? */
  function outcomeOf(key: string): Pick<ConfirmRow, 'outcome' | 'message'> {
    if (!saveFailed) return {};
    if (writtenOps.has(key)) return { outcome: 'saved' };
    if (key === saveFailed.failedId) return { outcome: 'failed', ...(saveFailed.rowMessage ? { message: saveFailed.rowMessage } : {}) };
    return { outcome: 'not-saved' };
  }

  function drawBar(): void {
    if (!index) { bar.draw(null); return; }
    const changed = changedExisting();
    if (!news.length && !changed.length) { bar.draw(null); return; }
    const rows: ConfirmRow[] = [];
    const thumbImg = (url: string | undefined, fallback?: ThumbState, dark = false) => {
      const src = url ?? (fallback?.state === 'ready' ? fallback.url : undefined);
      return src ? attrs(el('img', `ci-pthumb${dark ? ' on-dark' : ''}`), { src, alt: '' }) : el('span', 'ci-pthumb');
    };
    let problem = '';
    for (const n of news) {
      const m = made.get(n.key);
      const p = idProblem(n, index, news);
      if (p && !problem) problem = p;
      rows.push({
        lead: el('span', 'ci-pair', el('span', 'ci-plus', icon('i-plus', 'ic-sm')), thumbImg(m?.url ?? objectUrls.get(n.key), undefined, whiteOnly(n.key))), name: outputName(n.fileName, m?.out?.mime ?? n.mime),
        detail: `${n.id}  in ${folderPath(index, n.folderId) || n.folderId}${n.description.trim() ? `  ·  ${n.description.trim()}` : ''}`, ...(p ? { problem: p } : {}),
        ...outcomeOf(opKey('add', n.id)),
      });
    }
    for (const f of changed) {
      const m = made.get(f.rid);
      const name = m?.out ? outputName(f.name, m.out.mime) : f.name;
      const rep = replaced.get(f.rid);
      rows.push({
        lead: el('span', 'ci-pair', thumbImg(undefined, thumbs.peek(f.rid)), icon('i-arrow', 'ic-sm'), thumbImg(m?.url)),
        name, detail: [f.id, rep ? `file replaced with ${rep.fileName}` : '', name !== f.name ? `was ${f.name}` : ''].filter(Boolean).join('  ·  '),
        ...(m?.error ? { problem: m.error } : {}),
        ...outcomeOf(opKey('change', f.id)),
      });
    }
    const nChanges = news.length + changed.length;
    const ready = preparing === 0 && [...news.map(n => n.key), ...changed.map(f => f.rid)].every(k => made.get(k)?.out);
    // A file too large for one write is said before the save, not after it.
    let skipped = '';
    let writable = nChanges;
    if (ready) {
      const { tooLarge } = buildFileOps(
        news.map(n => ({ item: n, out: made.get(n.key)!.out! })), changed.map(f => ({ file: f, out: made.get(f.rid)!.out! })), bytesToBase64);
      if (tooLarge.length) { skipped = `Left out: ${tooLargeText(tooLarge)}`; writable -= tooLarge.length; }
    }
    const toFix = rows.filter(r => r.problem).length;
    const leftOut = nChanges - writable;
    const flag = [toFix ? `${toFix} to fix` : '', leftOut ? `${leftOut} left out` : ''].filter(Boolean).join(', ');
    const firstProblem = problem || rows.find(r => r.problem)?.problem || '';
    bar.draw({
      count: writable,
      rows,
      ...(skipped ? { skipped } : {}),
      ...(changed.length ? { note: changed.length === 1 ? 'Changes it everywhere it is linked.' : 'Changes them everywhere they are linked.' } : {}),
      ...(flag ? { flag } : {}),
      ...(firstProblem ? { blocked: firstProblem } : !ready ? { blocked: 'The files are being prepared' } : {}),
      ...(phase ? { phase } : {}),
      failure: saveFailed,
      canSave: ready && writable > 0 && !firstProblem,
      onSave: () => { void save(); },
      onDiscard: () => { discard(); },
    });
  }

  function forgetWork(): void {
    for (const u of objectUrls.values()) URL.revokeObjectURL(u);
    objectUrls.clear();
    for (const m of made.values()) if (m.url) URL.revokeObjectURL(m.url);
    made.clear();
    replaced.clear();
    for (const k of [...svgInfo.keys()]) if (!sources.has(k)) svgInfo.delete(k);
    news = []; selection = new Set(); settings = defaults();
    closeColorPop();
  }

  function discard(): void {
    forgetWork();
    saveFailed = null; writtenOps.clear(); note = '';
    drawAll();
  }

  async function save(): Promise<void> {
    if (!index || phase) return;
    const changed = changedExisting();
    const newOut: Array<{ item: NewImage; out: ImageOutput }> = [];
    const changeOut: Array<{ file: ImageFile; out: ImageOutput }> = [];
    for (const n of news) { const o = made.get(n.key)?.out; if (!o) return; newOut.push({ item: n, out: o }); }
    for (const f of changed) { const o = made.get(f.rid)?.out; if (!o) return; changeOut.push({ file: f, out: o }); }
    const { ops, tooLarge } = buildFileOps(newOut, changeOut, bytesToBase64);
    if (!ops.length) return;
    // After a save that stopped part way, what it wrote (exactly as now) is not sent again.
    const keyOf = (op: FileOp) => opKey(op.kind, op.id);
    const send = ops.filter(op => writtenOps.get(keyOf(op)) !== JSON.stringify(op));
    phase = 'saving'; saveFailed = null; drawBar();
    try {
      const out = send.length ? await ctx.work(writeChanges(ctx.environment, [], send)) : { ok: true, written: 0 };
      for (const op of send.slice(0, out.written)) writtenOps.set(keyOf(op), JSON.stringify(op));
      if (!out.ok) {
        const stopped = send[out.written];
        const prefix = stopped ? `${stopped.name}: ` : '';
        const message = out.error?.startsWith(prefix) ? out.error.slice(prefix.length) : out.error;
        const done = ops.filter(op => writtenOps.get(keyOf(op)) === JSON.stringify(op)).length;
        const f = saveFailure(ops.length, done, out.error, out.outcomeUnknown);
        // BMP's message goes on the row of the file it stopped at; with no answer at all it stays above the list.
        saveFailed = stopped && !out.outcomeUnknown ? { sentence: f.sentence, failedId: keyOf(stopped), ...(message ? { rowMessage: message } : {}) } : f;
        return;
      }
      // A fresh read of the list, then of the files that were changed.
      phase = 'checking'; drawBar();
      let bad: string[] = [];
      try {
        const r = await ctx.work(readImages(true));
        index = { folders: r.folders, files: r.files }; tree = buildImageTree(index); fetchedAt = r.fetchedAt;
        bad = verifyFiles(ops, index);
        const changedRids = changeOut.map(c => c.file.rid);
        thumbs.clear(); sources.clear(); svgInfo.clear();
        if (changedRids.length && !bad.length) {
          const back = await ctx.work(readImageBytes(changedRids));
          for (const c of changeOut) {
            const got = back.find(b => b.rid === c.file.rid);
            const sent = bytesToBase64(c.out.bytes);
            if (!got?.base64 || got.base64 !== sent) bad.push(`${c.file.name} does not read back as written`);
          }
        }
      } catch (e) {
        bad = [`The list could not be read again: ${e instanceof Error ? e.message : String(e)}`];
      }
      const n = ops.length;
      result = bad.length ? `Saved, but BMP does not hold it as sent: ${bad[0]}` : '';
      if (tooLarge.length) note = tooLargeText(tooLarge);
      resultBad = bad.length > 0;
      if (!bad.length) bar.saved(`Saved ${n} change${n === 1 ? '' : 's'}`);
      writtenOps.clear();
      forgetWork();
    } finally {
      phase = null;
      drawAll();
    }
  }

  // ── adding and replacing ──────────────────────────────────────────

  /** Library images to a folder: the view goes to that folder, with them selected under New. */
  function addFromLibrary(files: PickedFile[], folderId: string): void {
    if (!index) return;
    // A selection with unsaved changes to existing images stays; otherwise the new images are the selection.
    if (!changedExisting().length) { selection = new Set(); settings = defaults(); closeColorPop(); }
    selFolder = folderId; libView = null; query = '';
    reveal(folderId);
    scrollToTop = true;
    const before = news.length;
    add(files, folderId);
    const n = news.length - before;
    if (n) addedNote = `${n} image${n === 1 ? '' : 's'} added to ${index.folders.find(f => f.id === folderId)?.name ?? folderId}. Save to write ${n === 1 ? 'it' : 'them'} to BMP.`;
    drawAll();
  }

  function add(files: PickedFile[], folderId?: string): void {
    if (!index) return;
    const folder = folderId ?? targetFolder();
    if (!folder) { note = 'This workspace has no folder to add files to.'; drawGrid(); return; }
    const { added, skipped } = newImagesFor(files, folder, index, news, () => `n${++counter}`);
    note = skipped.length ? `${skipped.length} file${skipped.length === 1 ? ' is' : 's are'} not an image and ${skipped.length === 1 ? 'was' : 'were'} left out.` : '';
    if (!added.length) { drawGrid(); return; }
    // The newest first, under New.
    news = [...added, ...news];
    for (const a of added) selection.add(a.key);
    result = '';
    prepare();
    drawAll();
    // A file that does not fit one write is marked at once and is not selected; the rest are.
    void Promise.allSettled(added.map(a => made.get(a.key)?.promise)).then(() => {
      const over = added.filter(a => overText(a.key) !== null);
      for (const a of over) selection.delete(a.key);
      if (over.length) drawAll();
    });
  }

  async function replaceWith(rid: string, picked: PickedFile[]): Promise<void> {
    const file = picked[0];
    const f = existing(rid);
    if (!file || !f) return;
    const mime = imageMime(file.name);
    if (!mime) { note = `${file.name} is not an image.`; drawGrid(); return; }
    replaced.set(rid, { bytes: file.bytes, mime, fileName: file.name });
    svgInfo.delete(rid);
    // The new file's own colors decide what can be swapped.
    if (settings.color.mode === 'swap') settings = { ...settings, color: { ...settings.color, map: {} } };
    note = ''; result = '';
    prepare();
    drawAll();
  }

  fileInput.addEventListener('change', () => {
    const list = fileInput.files;
    if (list?.length) void filesFromInput(list).then(add);
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    const list = folderInput.files;
    if (list?.length) void filesFromFolder(list).then(add);
    folderInput.value = '';
  });
  replaceInput.addEventListener('change', () => {
    const list = replaceInput.files;
    const rid = [...selection][0];
    if (list?.length && rid) void filesFromInput(list).then(p => replaceWith(rid, p));
    replaceInput.value = '';
  });
  root.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); root.classList.add('dropping'); } });
  root.addEventListener('dragleave', e => { if (e.target === root || !root.contains(e.relatedTarget as Node | null)) root.classList.remove('dropping'); });
  root.addEventListener('drop', e => {
    root.classList.remove('dropping');
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    void filesFromDrop(e.dataTransfer).then(add);
  });

  function drawAll(): void {
    drawSide(); drawGrid(); drawPanel(); drawBar();
  }

  return {
    root,
    show() {
      root.hidden = false;
      library.load();
      if (!index && !loading) void load(false); else drawAll();
    },
    hasUnsaved: unsaved,
    selectFolder(id) { selFolder = id; userFolder = id; libView = null; reveal(id); if (index) drawAll(); },
  };
}
