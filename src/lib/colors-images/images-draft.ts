/**
 * The unsaved image changes of the Images tab: files added (with the IDs
 * proposed for them), existing files changed by the Adjust panel, the
 * operations the write sends and the check of the answer after the write.
 * Pure: no DOM, no chrome.*.
 */
import { EXTENSION_OF_MIME, extensionOf, imageMime, type ImageFile, type ImageIndex } from './image-files';
import { isValidId, proposeIds, type IdName } from './id-proposal';
import { FILE_LIMIT_KB, fileFits, type FileOp } from './write-ops';

/** A file added to the workspace, not yet written. */
export interface NewImage {
  key: string;
  /** The file name as dropped. */
  fileName: string;
  bytes: Uint8Array;
  mime: string;
  id: string;
  idTouched: boolean;
  folderId: string;
  /** The image's description in BMP ('' for none): a library icon's licence note, or what the person writes. */
  description: string;
  /** Set for an image from the library: the one colour it was added in (six lower-case hex
   *  digits, '' for none). Its proposed ID starts with `icon_` where the folder gives no
   *  prefix and ends with its colour. */
  library?: { hex: string };
}

/** The prefix a library image's ID gets where the IDs of its folder share none. */
export const LIBRARY_PREFIX = 'icon_';

/** What the ID of a new image is proposed from: its file name, and for a library image the
 *  `icon_` fallback and the colour it is written in (`hex`, or its own when not given). */
function idName(n: Pick<NewImage, 'fileName' | 'library'>, hex?: string): IdName {
  if (!n.library) return { name: n.fileName };
  return { name: n.fileName, fallbackPrefix: LIBRARY_PREFIX, suffix: hex ?? n.library.hex };
}

/**
 * The ID proposed again for a new image after its folder or colour changed: the
 * neighbours of its folder decide the prefix, `hex` (six hex digits, '' for none) the
 * colour at the end of a library image's ID. An ID the person typed is kept.
 */
export function reproposeId(n: NewImage, index: ImageIndex, news: readonly NewImage[], hex?: string): string {
  if (n.idTouched) return n.id;
  return proposeIds([idName(n, hex)], neighbourIds(index, n.folderId), takenFileIds(index, news, n.key))[0];
}

/** Words in a folder's name that tell which folder holds images of a library collection. */
const FOLDER_HINTS: Readonly<Record<string, string>> = { buttons: 'button', status: 'status' };

/**
 * The folder library images go to unless the person picks another: the BMP folder
 * selected in the sidebar; with All images, the folder that already holds most images of
 * this kind when its name tells it (one with "button" in its name for button icons,
 * "status" for status symbols), else the first folder (in the order given).
 */
export function defaultDestination(index: ImageIndex, selected: string | null, kind: string | null, order?: readonly string[]): string {
  if (selected && index.folders.some(f => f.id === selected)) return selected;
  const hint = kind ? FOLDER_HINTS[kind] : undefined;
  if (hint) {
    const count = (id: string) => index.files.filter(f => f.folderId === id).length;
    const named = index.folders.filter(f => f.name.toLowerCase().includes(hint))
      .map((f, i) => ({ id: f.id, n: count(f.id), i }))
      .sort((a, b) => b.n - a.n || a.i - b.i);
    if (named.length) return named[0].id;
  }
  const first = order?.find(id => index.folders.some(f => f.id === id));
  return first ?? index.folders[0]?.id ?? '';
}

/** The longest description written with an image. */
export const DESCRIPTION_LIMIT = 500;

/** The IDs next to a folder: the style new IDs follow. */
export function neighbourIds(index: ImageIndex, folderId: string): string[] {
  return index.files.filter(f => f.folderId === folderId).map(f => f.id);
}

export function takenFileIds(index: ImageIndex, news: readonly NewImage[], except?: string): string[] {
  return [...index.files.map(f => f.id), ...index.folders.map(f => f.id), ...news.filter(n => n.key !== except).map(n => n.id)];
}

/** New images for dropped files, in the order given, with proposed IDs.
 *  Files that are not images are left out; their names are returned. */
export function newImagesFor(
  files: ReadonlyArray<{ name: string; bytes: Uint8Array; description?: string; library?: { hex: string } }>, folderId: string, index: ImageIndex, existing: readonly NewImage[], nextKey: () => string,
): { added: NewImage[]; skipped: string[] } {
  const images = files.filter(f => imageMime(f.name) !== null);
  const ids = proposeIds(images.map(f => idName({ fileName: f.name, ...(f.library ? { library: f.library } : {}) })), neighbourIds(index, folderId), takenFileIds(index, existing));
  return {
    added: images.map((f, i): NewImage => ({
      key: nextKey(), fileName: f.name, bytes: f.bytes, mime: imageMime(f.name)!, id: ids[i], idTouched: false, folderId, description: f.description ?? '',
      ...(f.library ? { library: { hex: f.library.hex } } : {}),
    })),
    skipped: files.filter(f => imageMime(f.name) === null).map(f => f.name),
  };
}

/** The file name after an adjustment: the stem of the name, the extension of what is written. */
export function outputName(name: string, mime: string): string {
  const ext = EXTENSION_OF_MIME[mime] ?? (extensionOf(name) || 'png');
  const stem = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return `${stem}.${ext}`;
}

/** A problem with the ID of a new image, or ''. */
export function idProblem(n: NewImage, index: ImageIndex, news: readonly NewImage[]): string {
  if (!isValidId(n.id)) return 'Use letters, digits and _ in the ID';
  const lower = n.id.toLowerCase();
  if (takenFileIds(index, news, n.key).some(t => t.toLowerCase() === lower)) return 'This ID is taken';
  return '';
}

/** What the page has produced for one image: bytes and type to write. */
export interface Produced { bytes: Uint8Array; mime: string; base64?: string }

export interface FileChangeInput {
  file: ImageFile;
  out: Produced;
}

/** The write operations: the new files, then the changed ones. A file
 *  too large for one write is not an operation; its name is returned. */
export function buildFileOps(
  news: ReadonlyArray<{ item: NewImage; out: Produced }>, changes: readonly FileChangeInput[], toBase64: (b: Uint8Array) => string,
): { ops: FileOp[]; tooLarge: string[] } {
  const ops: FileOp[] = [];
  const tooLarge: string[] = [];
  for (const { item, out } of news) {
    const description = item.description.trim().slice(0, DESCRIPTION_LIMIT);
    const op: FileOp = {
      kind: 'add', folderId: item.folderId, id: item.id, name: outputName(item.fileName, out.mime), mime: out.mime, base64: out.base64 ?? toBase64(out.bytes),
      ...(description ? { description } : {}),
    };
    if (fileFits(op)) ops.push(op); else tooLarge.push(op.name);
  }
  for (const { file, out } of changes) {
    const name = outputName(file.name, out.mime);
    // BMP keeps the object's name when only the content is written (a preview on the server shows the name written
    // separately): a file that changes type is renamed in the same write, so `erm.svg` does not hold a PNG.
    const op: FileOp = { kind: 'change', id: file.id, name, mime: out.mime, base64: out.base64 ?? toBase64(out.bytes), ...(name !== file.name ? { rename: true } : {}) };
    if (fileFits(op)) ops.push(op); else tooLarge.push(op.name);
  }
  return { ops, tooLarge };
}

/** The stored content of a file in KB (rounded up): what one write counts. */
export function storedKb(base64: string): number {
  return Math.max(1, Math.ceil(base64.length * 0.75 / 1000));
}

/** What the page says of one file that does not fit a write: its size and the limit. */
export function overLimitText(name: string, base64: string): string {
  return `${name} is ${storedKb(base64)} KB. One write holds about ${FILE_LIMIT_KB} KB.`;
}

/** Does what the page produced for a file not fit one write? */
export function isOverLimit(file: { item: NewImage } | { file: ImageFile }, out: Produced, toBase64: (b: Uint8Array) => string): boolean {
  const { tooLarge } = 'item' in file ? buildFileOps([{ item: file.item, out }], [], toBase64) : buildFileOps([], [{ file: file.file, out }], toBase64);
  return tooLarge.length > 0;
}

/** After the write and a fresh read: what the list does not hold as sent. */
export function verifyFiles(ops: readonly FileOp[], index: ImageIndex): string[] {
  const byId = new Map(index.files.map(f => [f.id, f]));
  const bad: string[] = [];
  for (const op of ops) {
    const got = byId.get(op.id);
    if (!got) { bad.push(`${op.name} was not found`); continue; }
    if (op.kind === 'add' && got.folderId !== op.folderId) bad.push(`${op.name} is in another folder`);
    if (got.name !== op.name) bad.push(`${op.id} is named ${got.name}`);
  }
  return bad;
}
