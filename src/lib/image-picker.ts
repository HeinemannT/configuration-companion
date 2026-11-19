/**
 * The image picker of a button (and of an image view): a compact popover in
 * the property row of the object window. Search, "None", and thumbnails of
 * the workspace's image files drawn on the object's own background color when
 * it has one, with a link "Open images" to the Colors and images page. A pick
 * is staged like any other property edit in that window; nothing is edited
 * here. Nothing is read until the popover is opened; thumbnails load for what
 * is in view.
 */
import { attrs, btn, el, icon } from './dom';
import { folderPath, type ImageFile, type ImageIndex } from './colors-images/image-files';
import { ThumbCache, type ThumbState } from './colors-images/thumb-cache';
import { rememberFileNames } from './file-link-props';

export interface ImageListRead { folders: ImageIndex['folders']; files: ImageIndex['files']; error?: string }

/** The window's copy of the image list and of the thumbnails read for it. */
export class ImageCatalogue {
  index: ImageIndex | null = null;
  status: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  error = '';
  private readonly subs = new Set<() => void>();

  constructor(readonly thumbs: ThumbCache, private readonly read: () => Promise<ImageListRead>) {}

  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }

  lookup(rid: string): ImageFile | undefined { return this.index?.files.find(f => f.rid === rid); }

  /** Read the list the first time it is needed. */
  async ensure(): Promise<void> {
    if (this.index || this.status === 'loading') return;
    this.status = 'loading'; this.error = '';
    this.publish();
    try {
      const r = await this.read();
      this.index = { folders: r.folders, files: r.files };
      rememberFileNames(r.files);
      this.status = 'ready';
      if (r.error) this.error = r.error;
    } catch (e) {
      this.status = 'error';
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.publish();
  }

  retry(): Promise<void> { this.index = null; this.status = 'idle'; return this.ensure(); }

  private publish(): void { for (const fn of this.subs) fn(); }
}

export interface ImagePickerOptions {
  anchor: HTMLElement;
  catalogue: ImageCatalogue;
  /** The RID of the file now linked, or ''. */
  currentRid: string;
  /** The object's own background color (CSS), drawn behind the thumbnails. */
  background: string | null;
  /** The RID of the file picked, or '' for None. */
  onPick: (rid: string) => void;
  /** "Open images": the page opens on the Images tab. */
  onOpenImages: () => void;
}

let closeCurrent: (() => void) | null = null;

export function openImagePicker(o: ImagePickerOptions): void {
  closeCurrent?.();
  const { catalogue } = o;
  let filter = '';
  let stopThumbs: Array<() => void> = [];

  const root = el('div', 'ip-popover ui');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Choose an image');
  const backdrop = el('div', 'ip-backdrop');
  const body = el('div', 'ip-body');
  const search = attrs(el('input', 'ip-search') as HTMLInputElement, { type: 'text', placeholder: 'Search images', 'aria-label': 'Search images', autocomplete: 'off', spellcheck: 'false' });
  const foot = el('div', 'ip-foot');
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { observer?.unobserve(e.target); (e.target as HTMLElement & { _load?: () => void })._load?.(); }
    }, { root: body, rootMargin: '80px' })
    : null;

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    unsubscribe();
    for (const s of stopThumbs) s();
    observer?.disconnect();
    backdrop.remove(); root.remove();
    if (closeCurrent === close) closeCurrent = null;
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const pick = (rid: string) => { o.onPick(rid); close(); };

  function tile(f: ImageFile): HTMLElement {
    const t = btn(`ip-tile${f.rid === o.currentRid ? ' on' : ''}`, `${f.name}, ${f.id}`, () => pick(f.rid));
    t.title = `${f.name}  ${f.id}`;
    if (o.background) t.style.background = o.background;
    const show = (s: ThumbState) => { if (s.state === 'ready') t.replaceChildren(attrs(el('img'), { src: s.url, alt: '', draggable: 'false' })); };
    (t as HTMLElement & { _load?: () => void })._load = () => { stopThumbs.push(catalogue.thumbs.want(f.rid, f.name, show)); };
    const known = catalogue.thumbs.peek(f.rid);
    if (known?.state === 'ready') show(known);
    else if (observer) observer.observe(t);
    else (t as HTMLElement & { _load?: () => void })._load?.();
    return t;
  }

  function draw(): void {
    for (const s of stopThumbs) s();
    stopThumbs = [];
    const { index, status, error } = catalogue;
    const parts: HTMLElement[] = [];
    if (!index) {
      parts.push(status === 'error'
        ? el('div', 'ip-note bad', el('span', '', error || 'The images could not be read.'), btn('ip-link', undefined, () => { void catalogue.retry(); }, 'Retry'))
        : el('div', 'ip-note', 'Reading the images…'));
    } else {
      const q = filter.trim().toLowerCase();
      const none = btn(`ip-none${o.currentRid === '' ? ' on' : ''}`, 'None', () => pick(''), el('i'), 'None');
      parts.push(none);
      const hits = index.files.filter(f => !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q) || folderPath(index, f.folderId).toLowerCase().includes(q));
      const byFolder = new Map<string, ImageFile[]>();
      for (const f of hits) byFolder.set(f.folderId, [...(byFolder.get(f.folderId) ?? []), f]);
      const order = [...byFolder.keys()].sort((a, b) => folderPath(index, a).localeCompare(folderPath(index, b), undefined, { numeric: true }));
      for (const id of order) {
        parts.push(el('div', 'ip-group', index.folders.find(f => f.id === id)?.name ?? id));
        parts.push(el('div', 'ip-grid', ...byFolder.get(id)!.map(tile)));
      }
      if (!hits.length) parts.push(el('div', 'ip-note', q ? 'No image matches.' : 'This workspace has no image files.'));
      if (error) parts.push(el('div', 'ip-note bad', error));
    }
    body.replaceChildren(...parts);
    const now = catalogue.lookup(o.currentRid);
    foot.replaceChildren(
      el('span', 'ip-current', now ? `${now.name} · ${now.id}` : o.currentRid ? 'Image linked' : 'No image'),
      btn('ip-link', undefined, () => { o.onOpenImages(); close(); }, 'Open images', icon('i-out', 'ic-sm')),
    );
    position();
  }

  function position(): void {
    const r = o.anchor.getBoundingClientRect();
    const w = 336;
    root.style.width = `${w}px`;
    root.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const h = root.offsetHeight || 320;
    root.style.top = `${(r.bottom + 4 + h > window.innerHeight - 8) ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  }

  search.addEventListener('input', () => { filter = search.value; draw(); });
  root.append(el('div', 'ip-q', icon('i-search', 'ic-sm'), search), body, foot);
  document.body.append(backdrop, root);
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', close);
  closeCurrent = close;
  const unsubscribe = catalogue.subscribe(draw);
  draw();
  search.focus();
  void catalogue.ensure();
}

export interface ImageEditorOptions {
  /** The RID of the file now linked (what is staged, else what is stored), or ''. */
  rid: string;
  /** Name and ID of that file when the window knows them. */
  name: string;
  id: string;
  /** The object's background color (CSS), or null; asked when the picker opens. */
  background: () => string | null;
  /** Runs before the picker opens (reads the colors the first time). */
  beforeOpen?: () => Promise<void>;
  dirty: boolean;
  catalogue: ImageCatalogue;
  onChange: (rid: string) => void;
  onOpenImages: () => void;
}

/** The control in the property row: the linked image (a small thumbnail when
 *  it has been read, else a glyph), its name and ID, a caret. A click opens
 *  the picker. */
export function createImageEditor(o: ImageEditorOptions): HTMLElement {
  const known = o.catalogue.lookup(o.rid);
  const name = known?.name ?? o.name;
  const id = known?.id ?? o.id;
  const mini = el('span', 'ip-mini');
  const bg = o.background();
  if (bg) mini.style.background = bg;
  const thumb = o.rid ? o.catalogue.thumbs.peek(o.rid) : undefined;
  if (thumb?.state === 'ready') mini.append(attrs(el('img'), { src: thumb.url, alt: '' }));
  else mini.append(icon('i-image', 'ic-sm'));
  const field = btn(`ip-field${o.dirty ? ' dirty' : ''}`, undefined, () => {
    const open = () => openImagePicker({ anchor: field, catalogue: o.catalogue, currentRid: o.rid, background: o.background(), onPick: o.onChange, onOpenImages: o.onOpenImages });
    if (o.beforeOpen) void o.beforeOpen().then(open, open); else open();
  }, mini,
  el('span', `ip-field-name${o.rid ? '' : ' none'}`, o.rid ? (name || 'Image linked') : 'No image'),
  o.rid && id ? el('code', 'ip-field-id', id) : null,
  icon('i-chev', 'ic-sm'));
  field.setAttribute('aria-haspopup', 'dialog');
  field.title = o.rid ? `Image: ${name || o.rid}. Click to change.` : 'No image. Click to pick one.';
  return el('div', `prop-cell ip-cell${o.dirty ? ' prop-cell--dirty' : ''}`, field);
}
