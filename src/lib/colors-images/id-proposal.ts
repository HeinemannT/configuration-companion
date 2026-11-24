/**
 * Proposed IDs for new objects, following the style of their neighbours:
 * where the IDs next to them start with `icon_`, a file called `erm.svg`
 * is proposed as `icon_erm`. Pure.
 */

import { sharedPrefix as wordsPrefix } from '../numeric-id-propose';

/** The text of a name as an ID part: lower case, letters and digits, words
 *  joined by `_`. */
export function idPart(name: string): string {
  return name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The leading word (with its `_`) most of the neighbours share, e.g.
 *  `icon_`; '' when no word is shared by at least half of them (two at
 *  least). */
export function sharedPrefix(neighbourIds: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const id of neighbourIds) {
    const m = /^([A-Za-z][A-Za-z0-9]*_)/.exec(id);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best = '', n = 0;
  for (const [prefix, count] of counts) if (count > n) { best = prefix; n = count; }
  return n >= 2 && n * 2 >= neighbourIds.length ? best : '';
}

/** A name to propose an ID for, with what the ID gets beyond it: `fallbackPrefix` where the
 *  neighbours share no prefix (`icon_` for a library image), `suffix` at its end (a colour). */
export interface IdName { name: string; fallbackPrefix?: string; suffix?: string }

/**
 * One ID per name, in the order given: the neighbours' prefix (or the name's
 * fallback prefix when they share none), then the name as an ID part, then
 * the name's suffix. An ID already taken (by a neighbour, by anything in
 * `taken` or by an earlier name of this call) gets `_2`, `_3` …
 * `neighbourIds` give the style; `taken` are all IDs of the workspace
 * that are known.
 */
export function proposeIds(names: ReadonlyArray<string | IdName>, neighbourIds: readonly string[], taken: Iterable<string> = []): string[] {
  const used = new Set<string>([...neighbourIds, ...taken].map(s => s.toLowerCase()));
  const shared = sharedPrefix(neighbourIds);
  return names.map(entry => {
    const { name, fallbackPrefix = '', suffix = '' } = typeof entry === 'string' ? { name: entry } : entry;
    const prefix = shared || fallbackPrefix;
    let part = idPart(name) || 'file';
    if (prefix && part.startsWith(prefix)) part = part.slice(prefix.length) || part;
    const end = idPart(suffix);
    if (end && !part.endsWith(`_${end}`)) part = `${part}_${end}`;
    let base = prefix + part;
    if (/^[0-9]/.test(base)) base = `img_${base}`;
    let id = base, n = 2;
    while (used.has(id.toLowerCase())) id = `${base}_${n++}`;
    used.add(id.toLowerCase());
    return id;
  });
}

/**
 * The ID of a new color in a set: the colors of the set decide.
 * Numbered IDs (`action_status_colour_1`, `_2` …) go on with the next number;
 * IDs that start with the same words (`swi_brand_blue`, `swi_brand_navy`)
 * give the new ID those words and the name; a set with no pattern gives the
 * set's ID and the name. An ID that is taken gets `_2`, `_3` …
 */
export function proposeColorId(name: string, setId: string, colorIds: readonly string[], taken: Iterable<string> = []): string {
  const used = new Set<string>([setId, ...colorIds, ...taken].map(s => s.toLowerCase()));
  const free = (id: string) => !used.has(id.toLowerCase());
  const counted = new Map<string, { base: string; sep: string; max: number; n: number }>();
  for (const id of colorIds) {
    const m = /^(.*[A-Za-z])(_?)([0-9]+)$/.exec(id);
    if (!m) continue;
    const key = m[1] + m[2];
    const c = counted.get(key) ?? { base: m[1], sep: m[2], max: 0, n: 0 };
    c.n++;
    c.max = Math.max(c.max, Number(m[3]));
    counted.set(key, c);
  }
  let top: { base: string; sep: string; max: number; n: number } | undefined;
  for (const c of counted.values()) if (!top || c.n > top.n) top = c;
  if (top && top.n >= 2 && top.n * 2 >= colorIds.length) {
    for (let n = top.max + 1; ; n++) { const id = top.base + top.sep + n; if (free(id)) return id; }
  }
  const prefix = (colorIds.length >= 2 ? wordsPrefix(colorIds) : null) ?? setId;
  let part = idPart(name) || 'color';
  if (part === prefix || part.startsWith(`${prefix}_`)) part = part.slice(prefix.length).replace(/^_/, '') || part;
  part = withoutOverlap(prefix, part);
  let base = `${prefix}_${part}`;
  if (!/^[A-Za-z_]/.test(base)) base = `color_${base}`;
  let id = base, n = 2;
  while (!free(id)) id = `${base}_${n++}`;
  return id;
}

/**
 * The words of `part` that the end of `prefix` already says, dropped: a prefix
 * of `set_brand` and a name `Brand teal` give `set_brand_teal`, not `set_brand_brand_teal`.
 * The prefix can end in a word of the neighbours' IDs (the neighbours of a scale or a paste).
 */
function withoutOverlap(prefix: string, part: string): string {
  const a = prefix.split('_'), b = part.split('_');
  for (let k = Math.min(a.length, b.length - 1); k >= 1; k--) {
    if (a.slice(-k).join('_') === b.slice(0, k).join('_')) return b.slice(k).join('_');
  }
  return part;
}

/** A valid BMP ID: letters, digits and `_`, not empty. */
export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_]{1,100}$/.test(id);
}
