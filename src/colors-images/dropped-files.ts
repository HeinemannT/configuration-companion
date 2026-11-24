/**
 * Files from a drop (also whole folders) or from the file picker, as
 * name and bytes. Only image files are kept by the caller; this reads
 * what it is given.
 */
import { isImageName } from '../lib/colors-images/image-files';

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  /** The description the image gets in BMP (a library icon's licence note). */
  description?: string;
  /** Set for an image from the library: the one colour it is added in ('' for none). */
  library?: { hex: string };
}

async function bytesOf(file: File): Promise<PickedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function entriesOf(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  // readEntries answers in parts until it answers with none.
  for (;;) {
    const part = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!part.length) return all;
    all.push(...part);
  }
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) out.push(await fileOf(entry as FileSystemFileEntry));
  else if (entry.isDirectory) for (const child of await entriesOf(entry as FileSystemDirectoryEntry)) await walk(child, out);
}

/** The files of a drop: dropped files, and every file under a dropped folder. */
export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const files: File[] = [];
  const entries = [...dt.items].map(i => (i.kind === 'file' ? i.webkitGetAsEntry?.() ?? null : null));
  if (entries.some(e => e)) {
    // The entries must be taken before the first await: the drop's data goes away after it.
    for (const entry of entries) if (entry) await walk(entry, files);
  } else files.push(...dt.files);
  return Promise.all(files.map(bytesOf));
}

export async function filesFromInput(list: FileList): Promise<PickedFile[]> {
  return Promise.all([...list].map(bytesOf));
}

/** The files of a picked folder (a directory input): every file in it and
 *  its subfolders, ordered by their path, as a dropped folder gives them.
 *  Only image files are read; any other file is passed on by name with no
 *  bytes, so the caller leaves it out and says so as it does for a drop. */
export async function filesFromFolder(list: FileList | readonly File[]): Promise<PickedFile[]> {
  const path = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
  const files = [...list].sort((a, b) => path(a).localeCompare(path(b), undefined, { numeric: true }));
  return Promise.all(files.map(f => (isImageName(f.name) ? bytesOf(f) : Promise.resolve({ name: f.name, bytes: new Uint8Array() }))));
}
