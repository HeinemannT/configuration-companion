/**
 * What the Colors and images page writes to BMP, as plain operations the
 * page sends and the service worker turns into Extended Code. Every ID,
 * colour and content is checked here; text goes through the EC literal
 * guard. No delete: nobody has verified what BMP does to objects still
 * linked to a deleted color or file.
 *
 *   - a colour: `t.<id>.change(color := "#RRGGBB", name := "…")`
 *   - a new colour in a set: `t.<set>.add(CorpoColor, id := …, name := …, color := …)`
 *   - a new set beside an existing one: its parent's `add(CorpoColorSet, …)`
 *   - a file: `t.<folder>.add(FileResource, id := …, name := …, content := "<name>;<mime>;<base64>")`
 *     and `r.<id>.change(content := …)`
 *
 * Pure: no DOM, no chrome.*.
 */
import { formatEcLiteral } from '../ec-guards';
import { isValidId } from './id-proposal';
import { normalizeHex } from './color-math';

export type ColorOp =
  | { kind: 'change'; id: string; name?: string; hex?: string }
  | { kind: 'add'; setId: string; id: string; name: string; hex: string }
  | { kind: 'addSet'; besideSetId: string; id: string; name: string };

export type FileOp =
  | { kind: 'add'; folderId: string; id: string; name: string; mime: string; base64: string }
  | { kind: 'change'; id: string; name: string; mime: string; base64: string };

/** The characters one write script may hold (Companion's limit for a
 *  user script is 25,000). */
export const SCRIPT_BUDGET = 24_000;

/** About how much stored content (KB, after compression) one file write holds. */
export const FILE_LIMIT_KB = Math.floor((SCRIPT_BUDGET - 400) * 0.75 / 1000);

/** What the page says of files that do not fit, before the person confirms. */
export function tooLargeText(names: readonly string[]): string {
  const one = names.length === 1;
  return `${names.join(', ')} ${one ? 'is' : 'are'} over what one write holds (about ${FILE_LIMIT_KB} KB, SVG files compressed). Add ${one ? 'it' : 'them'} in Configuration Studio.`;
}

const lit = (s: string) => `"${formatEcLiteral(s)}"`;

function need(ok: boolean, text: string): void {
  if (!ok) throw new Error(text);
}

/** The EC for colour operations, in order. A set added in the same
 *  list takes the colours added to it. */
export function buildColorWriteEc(ops: readonly ColorOp[]): string {
  const lines: string[] = [];
  const newSets = new Map<string, string>();
  for (const op of ops) {
    if (op.kind === 'addSet') {
      need(isValidId(op.id) && isValidId(op.besideSetId), `Not a valid ID: ${op.id}`);
      need(op.name.trim().length > 0, 'A color set needs a name');
      const v = `_s${newSets.size + 1}`;
      newSets.set(op.id, v);
      lines.push(`_p${newSets.size} := t.${op.besideSetId}.parent`);
      lines.push(`${v} := _p${newSets.size}.add(CorpoColorSet, id := ${lit(op.id)}, name := ${lit(op.name.trim())})`);
    } else if (op.kind === 'add') {
      const hex = normalizeHex(op.hex);
      need(isValidId(op.id) && isValidId(op.setId), `Not a valid ID: ${op.id}`);
      need(hex !== null, `Not a color: ${op.hex}`);
      const set = newSets.get(op.setId) ?? `t.${op.setId}`;
      lines.push(`${set}.add(CorpoColor, id := ${lit(op.id)}, name := ${lit(op.name.trim() || op.id)}, color := ${lit(hex!)})`);
    } else {
      need(isValidId(op.id), `Not a valid ID: ${op.id}`);
      const parts: string[] = [];
      if (op.name !== undefined) { need(op.name.trim().length > 0, 'A color needs a name'); parts.push(`name := ${lit(op.name.trim())}`); }
      if (op.hex !== undefined) {
        const hex = normalizeHex(op.hex);
        need(hex !== null, `Not a color: ${op.hex}`);
        parts.push(`color := ${lit(hex!)}`);
      }
      if (parts.length) lines.push(`t.${op.id}.change(${parts.join(', ')})`);
    }
  }
  return lines.join('\n');
}

/** The `<name>;<mime>;<base64>` triplet BMP stores as a file's content.
 *  ';' is the delimiter, so it is taken out of the name. */
export function fileContent(name: string, mime: string, base64: string): string {
  return `${name.replace(/;/g, '')};${mime.replace(/;/g, '')};${base64}`;
}

function fileLine(op: FileOp): string {
  need(/^[A-Za-z0-9+/=\s]*$/.test(op.base64), 'The file content is not base64');
  need(/^[a-z]+\/[a-z0-9.+-]+$/i.test(op.mime), `Not a media type: ${op.mime}`);
  need(op.name.trim().length > 0, 'A file needs a name');
  const content = lit(fileContent(op.name.trim(), op.mime, op.base64.replace(/\s+/g, '')));
  if (op.kind === 'change') {
    need(isValidId(op.id), `Not a valid ID: ${op.id}`);
    return `r.${op.id}.change(content := ${content})`;
  }
  need(isValidId(op.id) && isValidId(op.folderId), `Not a valid ID: ${op.id}`);
  return `t.${op.folderId}.add(FileResource, id := ${lit(op.id)}, name := ${lit(op.name.trim())}, content := ${content})`;
}

/** The EC for one file operation. */
export function buildFileWriteEc(op: FileOp): string {
  return fileLine(op);
}

/** Whether one file's script fits a write (large files are left to BMP). */
export function fileFits(op: FileOp): boolean {
  try { return fileLine(op).length <= SCRIPT_BUDGET; } catch { return false; }
}
