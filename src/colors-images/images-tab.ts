/**
 * The Images tab: the folders of the workspace that hold image files (nested
 * as they are in BMP, with counts) on the left, the images as tiles, an
 * Adjust panel on the right (color, size, padding, format, with a preview).
 * Drop files or a folder, or use "Add files": new files appear under New with
 * IDs proposed from their names. One confirm bar lists what a save adds or
 * changes; the write is previewed on the server, and a fresh read checks it.
 * File content is read only for the thumbnails in view and for the images
 * the person selects to adjust.
 */
import { attrs, btn, el, icon } from '../lib/dom';
import { normalizeHex } from '../lib/colors-images/color-math';
import {
  buildImageTree, EXTENSION_OF_MIME, folderPath, imagesIn, totalImages, type FolderNode, type ImageFile, type ImageIndex,
} from '../lib/colors-images/image-files';
import {
  buildFileOps, idProblem, isOverLimit, newImagesFor, outputName, overLimitText, verifyFiles, type NewImage,
} from '../lib/colors-images/images-draft';
import {
  bytesToBase64, DEFAULT_ADJUST, processImage, SIZES, type AdjustSettings, type ImageOutput,
} from '../lib/colors-images/image-process';
import { encodeContent } from '../lib/colors-images/content-encoding';
import { tooLargeText } from '../lib/colors-images/write-ops';
import { ThumbCache, type ThumbState } from '../lib/colors-images/thumb-cache';
import { readImageBytes, readImages, writeChanges } from './api';
import { drawConfirmBar, readFoot, statusBlock, type ConfirmRow, type PageCtx } from './common';
import { filesFromDrop, filesFromInput, type PickedFile } from './dropped-files';
import type { Tab } from './colors-tab';

type Format = 'auto' | 'svg' | 'png';
interface Settings { color: AdjustSettings['color']; size: AdjustSettings['size']; padding: number; format: Format }

const DEFAULTS: Settings = { color: { mode: 'original', hex: DEFAULT_ADJUST.color.hex }, size: 'keep', padding: 0, format: 'auto' };

interface Made { sig: string; promise: Promise<ImageOutput>; out?: ImageOutput; url?: string; error?: string }

export function createImagesTab(ctx: PageCtx): Tab & { selectFolder(id: string | null): void } {
  let index: ImageIndex | null = null;
  let tree: FolderNode[] = [];
  let fetchedAt: number | null = null;
  let loadError = '';
  let loading = false;
  let selFolder: string | null = null;
  let query = '';
  let news: NewImage[] = [];
  let selection = new Set<string>();
  let settings: Settings = { ...DEFAULTS, color: { ...DEFAULTS.color } };
  let counter = 0;
  let saving = false;
  let saveError = '';
  let result = '';
  let resultBad = false;
  let note = '';
  let preparing = 0;
  const made = new Map<string, Made>();
  const objectUrls = new Map<string, string>();

  const thumbs = new ThumbCache(async rids => readImageBytes(rids));
  const side = el('div', 'ci-side');
  const main = el('div', 'ci-main');
  const panel = el('div', 'ci-panel');
  const bar = el('div', 'ci-confirm');
  bar.hidden = true;
  const root = el('div', 'ci-view ci-images', side, main, panel, bar);
  root.hidden = true;
  const fileInput = attrs(el('input') as HTMLInputElement, { type: 'file', multiple: '', accept: 'image/*', hidden: '' });
  root.append(fileInput);

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
      if (force) thumbs.clear();
      if (selFolder !== null && !folderPath(index, selFolder)) selFolder = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      drawAll();
    }
  }

  // ── what the settings do to a file ────────────────────────────────

  const isSvgMime = (mime: string) => mime === 'image/svg+xml';

  /** The format written for a file of this type: an SVG stays an SVG (BMP draws it on a button) unless PNG is chosen; a picture is PNG when adjusted. */
  function formatFor(mime: string): 'svg' | 'png' {
    if (!isSvgMime(mime)) return 'png';
    if (settings.format !== 'auto') return settings.format;
    return 'svg';
  }

  function adjustFor(mime: string, isNew: boolean): AdjustSettings {
    return { color: settings.color, size: settings.size, padding: settings.padding, format: formatFor(mime) };
  }

  /** Does the person's choice change this existing file at all? */
  function touches(file: ImageFile, mime: string): boolean {
    if (settings.color.mode === 'one' || settings.size !== 'keep' || settings.padding > 0) return true;
    return isSvgMime(mime) && settings.format === 'png';
  }

  function sigOf(a: AdjustSettings): string {
    return JSON.stringify([a.color.mode === 'one' ? a.color.hex : '', a.size, a.padding, a.format]);
  }

  /** Start (or reuse) the processing of one source under the current settings. */
  function make(key: string, source: { bytes: Uint8Array; mime: string }, isNew: boolean): Made {
    const adjust = adjustFor(source.mime, isNew);
    const sig = sigOf(adjust);
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
    timer = setTimeout(() => { drawGrid(); drawPreview(); drawBar(); }, 40);
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
    if (!f || !selection.has(key) || !touches(f, mimeOfName(f.name))) return null;
    return isOverLimit({ file: f }, out, bytesToBase64) ? overLimitText(outputName(f.name, out.mime), base64) : null;
  }

  /** Existing files the current settings change, with their bytes once read. */
  function changedExisting(): ImageFile[] {
    if (!index) return [];
    return [...selection].map(existing).filter((f): f is ImageFile => !!f && touches(f, mimeOfName(f.name)));
  }

  const mimeOfName = (name: string): string => (/\.svg$/i.test(name) ? 'image/svg+xml' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/' + (name.split('.').pop() ?? 'png').toLowerCase());

  /** Produce outputs for every new image and every changed file (reading the bytes of the latter). */
  function prepare(): void {
    for (const n of news) make(n.key, { bytes: n.bytes, mime: n.mime }, true);
    for (const f of changedExisting()) {
      void thumbs.bytes(f.rid, f.name).then(t => { make(f.rid, { bytes: t.bytes, mime: t.mime }, false); schedule(); }, () => schedule());
    }
  }

  // ── the folders ───────────────────────────────────────────────────

  function drawSide(): void {
    const head = el('div', 'ci-side-h', el('span', '', 'Folders'));
    const list = el('div', 'ci-side-list');
    if (index) {
      const row = (id: string | null, label: string, n: number, depth: number, title?: string) => {
        const b = btn(`ci-srow${selFolder === id ? ' on' : ''}`, undefined, () => { selFolder = id; query = ''; drawAll(); },
          el('span', 'ci-srow-name', label), el('span', 'ci-n', String(n)));
        b.style.paddingLeft = `${8 + depth * 12}px`;
        if (title) b.title = title;
        return b;
      };
      list.append(row(null, 'All images', totalImages(tree), 0));
      const walk = (nodes: FolderNode[], depth: number) => {
        for (const n of nodes) { list.append(row(n.id, n.name, n.count, depth, folderPath(index!, n.id))); walk(n.children, depth + 1); }
      };
      walk(tree, 0);
    }
    side.replaceChildren(head, list, readFoot(fetchedAt, () => { void load(true); }, unsaved() ? 'Save or cancel the changes first' : undefined));
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

  function tile(key: string, name: string, id: string, thumb: HTMLElement, opts: { selected: boolean; badge?: string; idInput?: NewImage; over?: string | null }): HTMLElement {
    const t = el('div', `ci-itile${opts.selected ? ' on' : ''}`);
    const check = opts.selected ? el('span', 'ci-ck', icon('i-check', 'ic-sm')) : null;
    thumb.append(...[check, opts.over ? attrs(el('span', 'ci-over', 'Too large'), { title: opts.over }) : null, opts.badge ? el('span', 'ci-fmt', opts.badge) : null].filter((x): x is HTMLElement => !!x));
    const pick = btn('ci-itile-pick', `${name}, ${id}`, () => {
      if (selection.has(key)) selection.delete(key); else selection.add(key);
      result = '';
      resetFormatForSelection();
      prepare();
      drawAll();
    }, thumb);
    pick.setAttribute('aria-pressed', String(opts.selected));
    t.append(pick, el('div', 'ci-nm', name));
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
    } else t.append(el('div', 'ci-id', id));
    return t;
  }

  function newTile(n: NewImage): HTMLElement {
    const m = made.get(n.key);
    const thumb = el('div', 'ci-thumb');
    const url = m?.url ?? (objectUrls.get(n.key) ?? (() => { const u = URL.createObjectURL(new Blob([n.bytes as BlobPart], { type: n.mime })); objectUrls.set(n.key, u); return u; })());
    thumb.append(attrs(el('img'), { src: url, alt: '', draggable: 'false' }));
    const out = m?.out;
    return tile(n.key, outputName(n.fileName, out?.mime ?? n.mime), n.id, thumb, {
      selected: selection.has(n.key), badge: (EXTENSION_OF_MIME[out?.mime ?? n.mime] ?? 'png').toUpperCase(), idInput: n, over: overText(n.key),
    });
  }

  function fileTile(f: ImageFile): HTMLElement {
    const thumb = thumbBox(f.rid, f.name);
    const m = made.get(f.rid);
    if (m?.url && selection.has(f.rid) && touches(f, mimeOfName(f.name))) {
      thumb.replaceChildren(attrs(el('img'), { src: m.url, alt: '', draggable: 'false' }));
    }
    return tile(f.rid, f.name, f.id, thumb, { over: overText(f.rid), selected: selection.has(f.rid), badge: /\.svg$/i.test(f.name) ? 'SVG' : /\.png$/i.test(f.name) ? 'PNG' : (f.name.split('.').pop() ?? '').toUpperCase() });
  }

  function dropTile(): HTMLElement {
    return btn('ci-itile drop', 'Add files', () => fileInput.click(), el('div', 'ci-thumb', icon('i-plus')), el('div', 'ci-nm muted', 'Drop files or a folder'));
  }

  function group(title: string, count: number, tiles: HTMLElement[]): HTMLElement {
    return el('section', 'ci-group', el('div', 'ci-ghead', title, el('span', 'ci-gn', String(count))), el('div', 'ci-igrid', ...tiles));
  }

  function drawGrid(): void {
    const scroll = main.querySelector<HTMLElement>('.ci-scroll');
    const top = scroll?.scrollTop ?? 0;
    const body = el('div', 'ci-scroll');
    if (!index) {
      main.replaceChildren(loading ? statusBlock('Reading the images…') : statusBlock(loadError || 'The images were not read.', () => { void load(true); }));
      return;
    }
    const groups: HTMLElement[] = [];
    if (news.length) groups.push(group('New', news.length, [...news.map(newTile), dropTile()]));
    const q = query.trim().toLowerCase();
    if (q) {
      const hits = index.files.filter(f => f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
      groups.push(group('Matches', hits.length, hits.map(fileTile)));
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
      if (!groups.length) groups.push(el('div', 'ci-state', 'No images here.'));
      if (!news.length) groups[0].querySelector('.ci-igrid')?.append(dropTile());
    }
    body.append(...groups);
    const head = el('div', 'ci-mhead', (() => {
      const input = attrs(el('input', 'ci-inp') as HTMLInputElement, { placeholder: 'Name or ID', 'aria-label': 'Search images' });
      input.value = query;
      input.addEventListener('input', () => { query = input.value; result = ''; drawGrid(); main.querySelector<HTMLInputElement>('.ci-search input')?.focus(); });
      return el('div', 'ci-search ui-search', icon('i-search', 'ic-sm'), input);
    })(), btn('ui-btn ci-add', undefined, () => fileInput.click(), icon('i-plus', 'ic-sm'), 'Add files'),
    loadError ? el('span', 'ci-warn', loadError) : null,
    note ? el('span', 'ci-warn', note) : null,
    result ? el('span', `ci-result${resultBad ? ' bad' : ''}`, result) : null);
    main.replaceChildren(head, body);
    body.scrollTop = top;
    const q2 = main.querySelector<HTMLInputElement>('.ci-search input');
    if (q2 && document.activeElement === document.body && query) { /* keep the caret where the person was typing */ q2.focus(); q2.setSelectionRange(query.length, query.length); }
  }

  // ── Adjust ────────────────────────────────────────────────────────

  function selectedCount(): number { return selection.size; }

  /** The format segment shows what would be written for the selection. */
  function shownFormat(): 'svg' | 'png' {
    if (settings.format !== 'auto') return settings.format;
    if ([...selection].some(k => newItem(k))) return 'png';
    const first = [...selection].map(existing).find(f => f);
    return first && /\.svg$/i.test(first.name) ? 'svg' : 'png';
  }

  /** A new selection starts from the file's own format: an SVG stays an SVG until PNG is chosen. */
  function resetFormatForSelection(): void {
    if (settings.format !== 'auto' && selection.size === 0) settings = { ...settings, format: 'auto' };
  }

  function segment<T extends string | number>(label: string, options: Array<{ value: T; text: string; disabled?: boolean; title?: string }>, current: T, set: (v: T) => void): HTMLElement {
    const group = attrs(el('span', 'ci-seg'), { role: 'group', 'aria-label': label });
    for (const o of options) {
      const b = btn(o.value === current ? 'on' : '', undefined, () => { if (!o.disabled) set(o.value); }, o.text);
      b.setAttribute('aria-pressed', String(o.value === current));
      if (o.disabled) { b.disabled = true; if (o.title) b.title = o.title; }
      group.append(b);
    }
    return group;
  }

  const previewBox = el('div', 'ci-preview');
  const overBox = el('div', 'ci-over-note');
  function drawPreview(): void {
    overBox.replaceChildren(...[...selection].map(overText).filter((t): t is string => !!t).map(t => el('p', 'ci-warn', t)));
    const keys = [...selection].slice(0, 4);
    const imgs: Node[] = [];
    for (const k of keys) {
      const m = made.get(k);
      const file = existing(k);
      const orig = file && !(file && touches(file, mimeOfName(file.name))) ? thumbs.peek(file.rid) : undefined;
      if (m?.url && (!file || touches(file, mimeOfName(file.name)))) imgs.push(attrs(el('img'), { src: m.url, alt: '' }));
      else if (orig?.state === 'ready') imgs.push(attrs(el('img'), { src: orig.url, alt: '' }));
      else if (m?.error) imgs.push(el('span', 'ci-warn', 'Cannot adjust'));
      else imgs.push(el('span', 'ci-spin'));
    }
    previewBox.replaceChildren(...imgs);
    previewBox.classList.toggle('empty', !imgs.length);
  }

  function changeSettings(next: Partial<Settings>): void {
    settings = { ...settings, ...next };
    result = '';
    prepare();
    drawPanel();
    drawGrid();
    drawBar();
  }

  function drawPanel(): void {
    const n = selectedCount();
    if (!index) { panel.replaceChildren(); return; }
    if (!n) {
      panel.replaceChildren(el('div', 'ci-ph', el('span', 'ci-title', 'Adjust')),
        el('p', 'ci-hint', 'Select images to adjust them. Drop files or a folder to add them.'));
      return;
    }
    const mixedRaster = [...selection].every(k => {
      const nm = newItem(k)?.fileName ?? existing(k)?.name ?? '';
      return !/\.svg$/i.test(nm);
    });
    const hexInput = attrs(el('input', 'ci-inp mono') as HTMLInputElement, { 'aria-label': 'Color', spellcheck: 'false', maxlength: '7' });
    hexInput.value = settings.color.hex;
    const chip = attrs(el('span', 'ci-chip lg'), { style: `background:${settings.color.hex}` });
    hexInput.addEventListener('input', () => {
      const v = normalizeHex(hexInput.value);
      if (!v) { hexInput.setAttribute('aria-invalid', 'true'); return; }
      hexInput.removeAttribute('aria-invalid');
      chip.style.background = v;
      settings = { ...settings, color: { mode: 'one', hex: v } };
      prepare(); drawGrid(); drawBar();
    });
    const padding = attrs(el('input', 'ci-inp mono narrow') as HTMLInputElement, { 'aria-label': 'Padding in px', inputmode: 'numeric', maxlength: '2' });
    padding.value = String(settings.padding);
    padding.addEventListener('input', () => {
      const v = Math.min(12, Math.max(0, Math.round(Number(padding.value) || 0)));
      settings = { ...settings, padding: v };
      prepare(); drawGrid(); drawBar();
    });
    const rows: HTMLElement[] = [
      el('div', 'ci-prop', el('span', '', 'Color'),
        segment('Color', [{ value: 'original', text: 'Original' }, { value: 'one', text: 'One color' }], settings.color.mode, v => changeSettings({ color: { ...settings.color, mode: v } }))),
    ];
    if (settings.color.mode === 'one') rows.push(el('div', 'ci-prop', el('span', ''), el('span', 'ci-inl', chip, hexInput)));
    rows.push(
      el('div', 'ci-prop', el('span', '', 'Size'),
        segment<string>('Size', [{ value: 'keep', text: 'Keep' }, ...SIZES.map(s => ({ value: String(s), text: String(s) }))], String(settings.size), v => changeSettings({ size: v === 'keep' ? 'keep' : Number(v) }))),
      el('div', 'ci-prop', el('span', '', 'Padding'), el('span', 'ci-inl', padding, el('span', 'ci-unit', 'px'))),
      el('div', 'ci-prop', el('span', '', 'Format'),
        segment<'svg' | 'png'>('Format', [
          { value: 'svg', text: 'SVG', disabled: mixedRaster, title: 'Only an SVG file can stay an SVG' },
          { value: 'png', text: 'PNG' },
        ], shownFormat(), v => changeSettings({ format: v }))),
    );
    const newSel = [...selection].map(newItem).filter((x): x is NewImage => !!x);
    if (newSel.length && index) {
      const sel = attrs(el('select', 'ci-select') as HTMLSelectElement, { 'aria-label': 'Folder for the new files' });
      const current = newSel[0].folderId;
      const options = index.folders.map(f => ({ id: f.id, path: folderPath(index!, f.id) })).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
      for (const o of options) {
        const opt = el('option', '', o.path) as HTMLOptionElement;
        opt.value = o.id; opt.selected = o.id === current;
        sel.append(opt);
      }
      sel.addEventListener('change', () => {
        for (const item of newSel) item.folderId = sel.value;
        drawBar();
      });
      rows.push(el('div', 'ci-prop', el('span', '', 'Folder'), sel));
    }
    panel.replaceChildren(el('div', 'ci-ph', el('span', 'ci-title', `Adjust ${n} image${n === 1 ? '' : 's'}`)), previewBox, overBox, ...rows,
      el('div', 'ci-end', btn('ci-link', undefined, () => { selection = new Set(); settings = { ...DEFAULTS, color: { ...DEFAULTS.color } }; drawAll(); }, 'Clear selection')));
    drawPreview();
  }

  // ── the confirm bar ───────────────────────────────────────────────

  function drawBar(): void {
    if (!index) { drawConfirmBar(bar, null); return; }
    const changed = changedExisting();
    if (!news.length && !changed.length) { drawConfirmBar(bar, null); return; }
    const rows: ConfirmRow[] = [];
    const thumbImg = (url: string | undefined, fallback?: ThumbState) => {
      const src = url ?? (fallback?.state === 'ready' ? fallback.url : undefined);
      return src ? attrs(el('img', 'ci-pthumb'), { src, alt: '' }) : el('span', 'ci-pthumb');
    };
    let problem = '';
    for (const n of news) {
      const m = made.get(n.key);
      const p = idProblem(n, index, news);
      if (p && !problem) problem = p;
      rows.push({
        lead: thumbImg(m?.url ?? objectUrls.get(n.key)), name: outputName(n.fileName, m?.out?.mime ?? n.mime),
        detail: `${n.id}  in ${folderPath(index, n.folderId) || n.folderId}`, ...(p ? { problem: p } : {}),
      });
    }
    for (const f of changed) {
      const m = made.get(f.rid);
      rows.push({
        lead: el('span', 'ci-pair', thumbImg(undefined, thumbs.peek(f.rid)), icon('i-arrow', 'ic-sm'), thumbImg(m?.url)),
        name: m?.out ? outputName(f.name, m.out.mime) : f.name, detail: f.id,
        ...(m?.error ? { problem: m.error } : {}),
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
    drawConfirmBar(bar, {
      title: `Save ${writable > 0 ? writable : nChanges} change${(writable > 0 ? writable : nChanges) === 1 ? '' : 's'}`,
      rows,
      ...(skipped ? { skipped } : {}),
      ...(changed.length ? { note: changed.length === 1 ? 'Changes it everywhere it is linked.' : 'Changes them everywhere they are linked.' } : {}),
      error: saveError || problem,
      saving,
      canSave: ready && writable > 0 && !problem && !rows.some(r => r.problem),
      onSave: () => { void save(); },
      onCancel: () => { discard(); },
    });
  }

  function discard(): void {
    for (const u of objectUrls.values()) URL.revokeObjectURL(u);
    objectUrls.clear();
    for (const m of made.values()) if (m.url) URL.revokeObjectURL(m.url);
    made.clear();
    news = []; selection = new Set(); settings = { ...DEFAULTS, color: { ...DEFAULTS.color } }; saveError = ''; note = '';
    drawAll();
  }

  async function save(): Promise<void> {
    if (!index || saving) return;
    const changed = changedExisting();
    const newOut: Array<{ item: NewImage; out: { bytes: Uint8Array; mime: string } }> = [];
    const changeOut: Array<{ file: ImageFile; out: { bytes: Uint8Array; mime: string } }> = [];
    for (const n of news) { const o = made.get(n.key)?.out; if (!o) return; newOut.push({ item: n, out: o }); }
    for (const f of changed) { const o = made.get(f.rid)?.out; if (!o) return; changeOut.push({ file: f, out: o }); }
    const { ops, tooLarge } = buildFileOps(newOut, changeOut, bytesToBase64);
    if (!ops.length) { saveError = tooLarge.length ? tooLargeText(tooLarge) : 'Nothing to save.'; drawBar(); return; }
    saving = true; saveError = ''; drawBar();
    try {
      const out = await ctx.work(writeChanges(ctx.environment, [], ops));
      if (!out.ok) {
        saveError = (out.outcomeUnknown ? `${out.error ?? 'No answer.'} BMP may have saved. Use Refresh to see what it holds.` : (out.error ?? 'The change was not written.'))
          + (out.written ? ` ${out.written} of ${ops.length} were written; Refresh to see them.` : '');
        return;
      }
      // A fresh read of the list, then of the files that were changed.
      let bad: string[] = [];
      try {
        const r = await ctx.work(readImages(true));
        index = { folders: r.folders, files: r.files }; tree = buildImageTree(index); fetchedAt = r.fetchedAt;
        bad = verifyFiles(ops, index);
        const changedRids = changeOut.map(c => c.file.rid);
        thumbs.clear();
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
      result = bad.length ? `Saved, but BMP does not hold it as sent: ${bad[0]}`
        : `Saved ${n} change${n === 1 ? '' : 's'}${tooLarge.length ? `. ${tooLargeText(tooLarge)}` : ''}`;
      resultBad = bad.length > 0;
      for (const u of objectUrls.values()) URL.revokeObjectURL(u);
      objectUrls.clear();
      for (const m of made.values()) if (m.url) URL.revokeObjectURL(m.url);
      made.clear();
      news = []; selection = new Set(); settings = { ...DEFAULTS, color: { ...DEFAULTS.color } };
    } finally {
      saving = false;
      drawAll();
    }
  }

  // ── adding ────────────────────────────────────────────────────────

  async function add(files: PickedFile[]): Promise<void> {
    if (!index) return;
    const folder = targetFolder();
    if (!folder) { note = 'This workspace has no folder to add files to.'; drawGrid(); return; }
    const { added, skipped } = newImagesFor(files, folder, index, news, () => `n${++counter}`);
    note = skipped.length ? `${skipped.length} file${skipped.length === 1 ? ' is' : 's are'} not an image and ${skipped.length === 1 ? 'was' : 'were'} left out.` : '';
    if (!added.length) { drawGrid(); return; }
    news = [...news, ...added];
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

  fileInput.addEventListener('change', () => {
    const list = fileInput.files;
    if (list?.length) void filesFromInput(list).then(add);
    fileInput.value = '';
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
      if (!index && !loading) void load(false); else drawAll();
    },
    hasUnsaved: unsaved,
    selectFolder(id) { selFolder = id; if (index) drawAll(); },
  };
}
