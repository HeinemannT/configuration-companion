/**
 * Properties that link an object to a file (a FileResource): the image of a
 * button (ActionButton.imageFile) or of an image view (ImageView.imageFile).
 * The object window offers a small image picker for them instead of the
 * generic reference editor (which is for custom properties only; a built-in
 * link had no editor at all).
 *
 * The window holds such a property as the RID of the file ('' when not set)
 * in the object's `props`, taken from the object's `references` when the read
 * is made (object-read.ts). It is written as `<prop> := lookup(<rid>)`, and
 * cleared with `""` (previewed on the server: BMP writes null).
 *
 * Pure: no DOM, no chrome.*.
 */

/** Property → the types that have it. */
export const FILE_LINK_PROPS: Readonly<Record<string, ReadonlySet<string>>> = {
  imageFile: new Set(['ActionButton', 'ImageView']),
};

/** The file-link properties the object window writes (see OBJECT_CHANGE_PROPS_SET). */
export const OBJECT_FILE_PROPS = ['imageFile'] as const;
export type ObjectFileProp = typeof OBJECT_FILE_PROPS[number];

export function isFileLinkProp(prop: string): prop is ObjectFileProp {
  return Object.hasOwn(FILE_LINK_PROPS, prop);
}

/** The file-link properties of a type. */
export function fileLinkPropsOf(type: string): ObjectFileProp[] {
  return OBJECT_FILE_PROPS.filter(p => FILE_LINK_PROPS[p].has(type));
}

const RID = /^-?\d+$/;

/** Names of files the window has read (the picker's list), by RID. */
const known = new Map<string, string>();

export function rememberFileNames(files: ReadonlyArray<{ rid: string; id: string; name: string }>): void {
  for (const f of files) known.set(f.rid, f.id && f.id !== f.name ? `${f.name} (${f.id})` : f.name);
}

/** A file-link value in words: the file's name and ID, "No image" for none,
 *  else what `fallback` knows (the object summaries), else the RID. */
export function fileLinkText(value: string, fallback?: (rid: string) => string | undefined): string {
  const rid = value.trim();
  if (!rid) return 'No image';
  return known.get(rid) ?? fallback?.(rid) ?? rid;
}

/** The EC for a file-link value: `lookup(<rid>)`, or `""` to clear when
 *  empty. null for a value that is not a RID. */
export function fileLinkRhs(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (text === '') return '""';
  return RID.test(text) ? `lookup(${text})` : null;
}
