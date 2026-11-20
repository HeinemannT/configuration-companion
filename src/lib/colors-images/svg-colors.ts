/**
 * The colors an SVG draws with, and swapping them one by one: `fill` and
 * `stroke` attributes, inline `style`, `<style>` rules and gradient
 * `stop-color`. A `url(#…)` paint (a gradient or pattern by reference) is
 * left alone, its stops are colors of their own; `currentColor` is one
 * entry; an embedded picture keeps its colors. A shape with no fill of its
 * own is drawn black, so black is listed for it and swapping black gives the
 * root that fill. Also the stroke width of a line icon. DOM only, no canvas.
 */
import { hexFromRgbText, normalizeHex } from './color-math';

/** The key of `currentColor` among the colors of an SVG. */
export const CURRENT_COLOR = 'currentColor';

const NAMED: Readonly<Record<string, string>> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00',
  orange: '#FFA500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#C0C0C0', navy: '#000080',
  teal: '#008080', maroon: '#800000', olive: '#808000', lime: '#00FF00', aqua: '#00FFFF', fuchsia: '#FF00FF',
  darkgray: '#A9A9A9', darkgrey: '#A9A9A9', lightgray: '#D3D3D3', lightgrey: '#D3D3D3', dimgray: '#696969', dimgrey: '#696969',
  gold: '#FFD700', crimson: '#DC143C', tomato: '#FF6347', steelblue: '#4682B4', royalblue: '#4169E1', whitesmoke: '#F5F5F5',
};

/** The key of a paint value: `#RRGGBB`, `currentColor`, or null for what is left alone (none, url(), inherit, an unknown name). */
export function paintKey(value: string): string | null {
  const v = value.trim().replace(/\s*!important$/i, '');
  const low = v.toLowerCase();
  if (low === 'currentcolor') return CURRENT_COLOR;
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(v)) return normalizeHex(v);
  if (/^#[0-9a-f]{8}$/i.test(v)) return normalizeHex(v.slice(0, 7));
  if (/^rgba?\(/i.test(v)) return hexFromRgbText(v);
  return NAMED[low] ?? null;
}

const PAINT_ATTRS = ['fill', 'stroke', 'stop-color', 'flood-color'] as const;
const CSS_PAINT = /(\b(?:fill|stroke|stop-color|flood-color)\s*:\s*)([^;}"\n]+)/gi;
const SHAPES = new Set(['path', 'circle', 'rect', 'polygon', 'polyline', 'ellipse', 'text', 'tspan', 'use']);
const NO_PAINT = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'image', 'foreignobject', 'metadata', 'title', 'desc', 'style']);

function elements(svg: Element): Element[] {
  const out: Element[] = [];
  const walker = svg.ownerDocument.createTreeWalker(svg, 1 /* SHOW_ELEMENT */);
  for (let n = walker.currentNode as Element | null; n; n = walker.nextNode() as Element | null) out.push(n);
  return out;
}

const lname = (e: Element) => (e.localName || e.tagName).toLowerCase();
const hasOwnFill = (e: Element) => e.hasAttribute('fill') || /(?:^|;)\s*fill\s*:/i.test(e.getAttribute('style') ?? '');

/** Does a shape draw with the default black fill (no fill on it or above it, no style sheet that sets fills)? */
function usesDefaultFill(svg: Element): boolean {
  const sheetFill = [...svg.getElementsByTagName('style')].some(s => /\bfill\s*:/i.test(s.textContent ?? ''));
  if (sheetFill) return false;
  for (const e of elements(svg)) {
    const tag = lname(e);
    if (!SHAPES.has(tag) || tag === 'use' || tag === 'tspan') continue;
    if (insideNoPaint(e, svg)) continue;
    let p: Element | null = e, own = false;
    while (p && !own) { own = hasOwnFill(p); if (p === svg) break; p = p.parentElement; }
    if (!own) return true;
  }
  return false;
}

function insideNoPaint(e: Element, svg: Element): boolean {
  for (let p = e.parentElement; p && p !== svg; p = p.parentElement) if (NO_PAINT.has(lname(p)) && lname(p) !== 'style') return true;
  return false;
}

/** A mask's or clip path's paint is its shape, not a color the icon shows. */
function inMaskOrClip(e: Element, svg: Element): boolean {
  for (let p: Element | null = e; p && p !== svg; p = p.parentElement) { const t = lname(p); if (t === 'mask' || t === 'clippath') return true; }
  return false;
}

export interface SvgColor { key: string; count: number }

/** The distinct colors of an SVG, most used first (ties in the order found). */
export function svgColors(svg: Element): SvgColor[] {
  const counts = new Map<string, number>();
  const add = (k: string | null) => { if (k) counts.set(k, (counts.get(k) ?? 0) + 1); };
  for (const e of elements(svg)) {
    const tag = lname(e);
    if (tag === 'style') { for (const m of (e.textContent ?? '').matchAll(CSS_PAINT)) add(paintKey(m[2])); continue; }
    if (tag === 'image' || inMaskOrClip(e, svg)) continue;
    for (const a of PAINT_ATTRS) { const v = e.getAttribute(a); if (v !== null) add(paintKey(v)); }
    const style = e.getAttribute('style');
    if (style) for (const m of style.matchAll(CSS_PAINT)) add(paintKey(m[2]));
  }
  if (usesDefaultFill(svg)) add('#000000');
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** The colors of SVG text; [] for text that is not an SVG. */
export function svgColorsOfText(text: string): SvgColor[] {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || lname(doc.documentElement) !== 'svg') return [];
  return svgColors(doc.documentElement);
}

/** Swap colors: every paint whose key is in `map` becomes the mapped hex. */
export function swapSvgColors(svg: Element, map: Readonly<Record<string, string>>): void {
  const swap = (value: string): string => {
    const k = paintKey(value);
    return k && map[k] ? map[k] : value;
  };
  const swapCss = (css: string) => css.replace(CSS_PAINT, (_m, prefix: string, value: string) => {
    const trailing = /\s*$/.exec(value)?.[0] ?? '';
    const next = swap(value);
    return next === value ? `${prefix}${value}` : `${prefix}${next}${trailing}`;
  });
  const usedDefault = usesDefaultFill(svg);
  for (const e of elements(svg)) {
    const tag = lname(e);
    if (tag === 'style') { if (e.textContent) e.textContent = swapCss(e.textContent); continue; }
    if (tag === 'image' || inMaskOrClip(e, svg)) continue;
    for (const a of PAINT_ATTRS) { const v = e.getAttribute(a); if (v !== null) e.setAttribute(a, swap(v)); }
    const style = e.getAttribute('style');
    if (style) e.setAttribute('style', swapCss(style));
  }
  if (usedDefault && map['#000000'] && !hasOwnFill(svg)) svg.setAttribute('fill', map['#000000']);
}

// ── line width ──────────────────────────────────────────────────────

const STROKE_WIDTH_CSS = /(\bstroke-width\s*:\s*)([^;}"\n]+)/gi;

/** Is this a line icon: does anything draw a stroke? */
export function hasStrokes(svg: Element): boolean {
  for (const e of elements(svg)) {
    const tag = lname(e);
    if (tag === 'style') { for (const m of (e.textContent ?? '').matchAll(/\bstroke\s*:\s*([^;}\n]+)/gi)) if (m[1].trim().toLowerCase() !== 'none') return true; continue; }
    const v = e.getAttribute('stroke');
    if (v !== null && v.trim().toLowerCase() !== 'none' && !/^url\(/i.test(v.trim())) return true;
    const m = /(?:^|;)\s*stroke\s*:\s*([^;]+)/i.exec(e.getAttribute('style') ?? '');
    if (m && m[1].trim().toLowerCase() !== 'none') return true;
  }
  return false;
}

/** Line widths offered (px on a 24 px icon). */
export const LINE_WIDTHS: readonly number[] = [1, 1.5, 2, 2.5];

/** Every stroke drawn `width` wide on a 24 unit grid, scaled to the SVG's viewBox. */
export function setStrokeWidth(svg: Element, width: number, viewBoxSize: number): void {
  const w = String(Math.round(width * (viewBoxSize / 24) * 100) / 100);
  for (const e of elements(svg)) {
    if (lname(e) === 'style') { if (e.textContent) e.textContent = e.textContent.replace(STROKE_WIDTH_CSS, (_m, p: string) => `${p}${w}`); continue; }
    if (e.hasAttribute('stroke-width')) e.setAttribute('stroke-width', w);
    const style = e.getAttribute('style');
    if (style && /stroke-width/i.test(style)) e.setAttribute('style', style.replace(STROKE_WIDTH_CSS, (_m, p: string) => `${p}${w}`));
  }
  svg.setAttribute('stroke-width', w);
}
