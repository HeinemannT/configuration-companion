/**
 * The workspace's image files as the Images tab and the image picker use
 * them: one cheap read of the folders (Category objects under the resources
 * root) and the FileResource objects (RID, ID, name, folder), then a tree of
 * only the folders that hold image files somewhere beneath them. A file is
 * an image by the extension of its name; no file content is read here.
 *
 * Rids are 64-bit: strings. Pure: no DOM, no chrome.*.
 */
import { constantScript } from '../script-kinds';

export interface ImageFolder { id: string; name: string; parentId: string }
export interface ImageFile { rid: string; id: string; name: string; folderId: string }

export interface ImageIndex {
  folders: ImageFolder[];
  /** Image files only. */
  files: ImageFile[];
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

export function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

export function isImageName(name: string): boolean {
  return Object.hasOwn(IMAGE_MIME, extensionOf(name));
}

/** The media type of an image file name; null for any other file. */
export function imageMime(name: string): string | null {
  const ext = extensionOf(name);
  return Object.hasOwn(IMAGE_MIME, ext) ? IMAGE_MIME[ext] : null;
}

export const EXTENSION_OF_MIME: Readonly<Record<string, string>> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// ── the read ────────────────────────────────────────────────────────

// Control characters as in the colour read: collision-free for BMP text.
export const FILE_FIELD = '\u0001';
export const FILE_ROW = '\u0002';

/** Folders and files in one read; a final count marker tells a complete
 *  answer from a cut one. */
export function buildImageIndexEc(): string {
  return constantScript('buildImageIndexEc', [
    '_cats := SELECT Category FROM root.EXTERNALRESOURCE',
    '_files := SELECT FileResource FROM root.EXTERNALRESOURCE',
    // calculate(...).join(""), never one text grown row by row.
    '_k := _cats.calculate(',
    '     _c := self',
    `     "K${FILE_FIELD}" + _c.id.whenMissing("") + "${FILE_FIELD}" + _c.name.whenMissing("") + "${FILE_FIELD}" + _c.parent.id.whenMissing("") + "${FILE_ROW}"`,
    ')',
    '_i := _files.calculate(',
    '     _f := self',
    `     "I${FILE_FIELD}" + str(_f.rid) + "${FILE_FIELD}" + _f.id.whenMissing("") + "${FILE_FIELD}" + _f.name.whenMissing("") + "${FILE_FIELD}" + _f.parent.id.whenMissing("") + "${FILE_ROW}"`,
    ')',
    `_k.join("") + _i.join("") + "D${FILE_FIELD}" + str(_files.size()) + "${FILE_ROW}"`,
  ].join('\n'));
}

/** Parse the read: every folder, and the files that are images. */
export function parseImageIndexLog(log: string): ImageIndex {
  const folders: ImageFolder[] = [];
  const files: ImageFile[] = [];
  let expected: number | null = null;
  let seen = 0;
  for (const wire of log.split(FILE_ROW)) {
    const p = wire.split(FILE_FIELD);
    const marker = (p[0] ?? '').trim();
    if (marker === 'D') { const n = Number((p[1] ?? '').trim()); if (Number.isInteger(n) && n >= 0) expected = n; continue; }
    if (marker === 'K') {
      const id = (p[1] ?? '').trim();
      if (id) folders.push({ id, name: (p[2] ?? '').trim() || id, parentId: (p[3] ?? '').trim() });
    } else if (marker === 'I') {
      const rid = (p[1] ?? '').trim(), name = (p[3] ?? '').trim();
      if (!/^-?\d+$/.test(rid)) continue;
      seen += 1;
      if (isImageName(name)) files.push({ rid, id: (p[2] ?? '').trim(), name, folderId: (p[4] ?? '').trim() });
    }
  }
  if (expected === null) throw new Error('Incomplete image answer: the answer was cut off');
  if (seen !== expected) throw new Error(`Incomplete image answer: expected ${expected} files, parsed ${seen}`);
  return { folders, files };
}

// ── the tree ────────────────────────────────────────────────────────

export interface FolderNode {
  id: string;
  name: string;
  /** Images in this folder and everything beneath it. */
  count: number;
  /** Images directly in this folder. */
  own: number;
  children: FolderNode[];
}

/** The folders that hold images somewhere beneath them, nested as they are
 *  in BMP, in the order of the read, with their counts. A folder whose parent
 *  is not a folder of the read (the resources root) is a root of the tree. */
export function buildImageTree(index: ImageIndex): FolderNode[] {
  const byId = new Map(index.folders.map(f => [f.id, f]));
  const own = new Map<string, number>();
  for (const f of index.files) own.set(f.folderId, (own.get(f.folderId) ?? 0) + 1);
  const children = new Map<string, ImageFolder[]>();
  const roots: ImageFolder[] = [];
  for (const f of index.folders) {
    if (f.parentId && byId.has(f.parentId) && f.parentId !== f.id) {
      children.set(f.parentId, [...(children.get(f.parentId) ?? []), f]);
    } else roots.push(f);
  }
  const build = (f: ImageFolder, guard: Set<string>): FolderNode | null => {
    if (guard.has(f.id)) return null;
    const next = new Set(guard).add(f.id);
    const kids = (children.get(f.id) ?? []).map(c => build(c, next)).filter((n): n is FolderNode => !!n && n.count > 0);
    const here = own.get(f.id) ?? 0;
    const count = here + kids.reduce((n, k) => n + k.count, 0);
    return count > 0 ? { id: f.id, name: f.name, count, own: here, children: kids } : null;
  };
  return roots.map(r => build(r, new Set())).filter((n): n is FolderNode => !!n);
}

/** The ids of a folder and every folder beneath it, in the tree. */
export function folderIds(tree: readonly FolderNode[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: FolderNode, inside: boolean) => {
    const on = inside || n.id === id;
    if (on) out.add(n.id);
    for (const c of n.children) walk(c, on);
  };
  for (const r of tree) walk(r, false);
  return out;
}

/** The images of a folder (`deep`: and of every folder beneath it); no
 *  folder means all of them. */
export function imagesIn(index: ImageIndex, tree: readonly FolderNode[], folder: string | null, deep = true): ImageFile[] {
  if (folder === null) return index.files;
  const ids = deep ? folderIds(tree, folder) : new Set([folder]);
  return index.files.filter(f => ids.has(f.folderId));
}

/** Total images in a tree. */
export function totalImages(tree: readonly FolderNode[]): number {
  return tree.reduce((n, r) => n + r.count, 0);
}

/** The path of folder names from the root to `id` ("Demo Items / Icons"). */
export function folderPath(index: ImageIndex, id: string): string {
  const byId = new Map(index.folders.map(f => [f.id, f]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
    seen.add(cur.id);
    out.unshift(cur.name);
  }
  return out.join(' / ');
}
