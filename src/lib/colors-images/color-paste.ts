/**
 * Colors found in pasted text: a brand guide, CSS, a list. Hex values
 * (`#RGB`, `#RRGGBB`, `#RRGGBBAA` with the alpha dropped) and `rgb()` /
 * `rgba()` values are found; the name is the label before the value on its
 * line (`--brand-teal: #0F8A9D`, `Primary  #0E8A9C`, `$navy: …`), else a
 * text line just above it (a guide that puts the name over the value).
 * The same value twice is listed once. Pure.
 */
import { normalizeHex, parseColor } from './color-math';

export interface FoundColor { name: string; hex: string }

/** At most this many colors from one paste. */
export const PASTE_LIMIT = 40;

const VALUE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\(\s*[^)]*\)/g;

/** A label as a color name: `--brand-primary` → `Brand primary`, `successGreen` → `Success green`. */
export function nameFromLabel(label: string): string {
  let t = label
    .replace(/\/\*|\*\/|\/\/|<[^>]*>/g, ' ')
    .replace(/^[\s\-–—•*·|>]+/, '')
    .replace(/^(?:--|\$|@)/, '')
    .replace(/[\s:=,;|(\-–—"'`]+$/, '')
    .replace(/["'`]/g, '')
    .trim();
  // A CSS selector or property before the value says nothing about the color.
  t = t.replace(/^(?:color|background(?:-color)?|fill|stroke|border(?:-color)?)$/i, '');
  // Nor does the name of a format in a guide (`HEX #0F8A9D`).
  t = t.replace(/\b(?:hex|rgba?|hsla?|web|code|value)\b[\s:]*$/i, '').trim();
  if (!t) return '';
  t = t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]/.test(t) || t.length > 60) return '';
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function hexOf(raw: string): string | null {
  if (raw.startsWith('#')) return normalizeHex(raw.length === 9 ? raw.slice(0, 7) : raw);
  return parseColor(raw, 'rgb');
}

/** The colors of a pasted text, in the order found. */
export function parsePastedColors(text: string): FoundColor[] {
  const out: FoundColor[] = [];
  const seen = new Set<string>();
  let lastLabel = '';
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(VALUE)];
    if (!matches.length) {
      const label = nameFromLabel(line);
      lastLabel = label.length <= 40 ? label : '';
      continue;
    }
    let from = 0;
    for (const m of matches) {
      const hex = hexOf(m[0]);
      const before = line.slice(from, m.index);
      from = (m.index ?? 0) + m[0].length;
      if (!hex) continue;
      // A label after the previous value on the line, or (for the first value) the line's own label or the one above.
      const own = nameFromLabel(before.replace(/.*[;{}]/, ''));
      // `#0E8A9C Primary`: one value with its label after it.
      const after = matches.length === 1 ? nameFromLabel(line.slice(from).replace(/^[\s\-–—:=,;)]+/, '')) : '';
      const name = own || after || (m === matches[0] ? lastLabel : '');
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push({ name, hex });
      if (out.length >= PASTE_LIMIT) return out;
    }
    lastLabel = '';
  }
  return out;
}
