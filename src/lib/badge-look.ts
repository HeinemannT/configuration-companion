/**
 * How Inspect mode draws an object's outline and where its badge reads
 * (content-overlays.ts, content-badge-layout.ts, content-current.ts). Pure:
 * no DOM, so every rule is unit-tested.
 *
 *  - Tick colour: the resting corner ticks use a darker tone of the type
 *    colour that reads on white (at least TICK_CONTRAST : 1). The badge keeps
 *    the type colour itself.
 *  - Nesting: a container (holds other marked objects, or a structural
 *    type) is drawn dashed and slightly outside, a widget solid, a part
 *    (fields, buttons, tabs, links) as short ticks with a dot.
 *  - Background: dark or image backgrounds (the portal's dark header,
 *    charts, pictures) give lines and badges a white keyline and a halo.
 *    Read from the computed background of the nearest opaque ancestor: no
 *    canvas sampling.
 *  - Locate: whether a target is on screen, and where the edge flag points.
 */

import { CHART_TYPES } from './type-registry';

/** Minimum contrast of a resting tick against white. */
export const TICK_CONTRAST = 4.8;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const toHex = (c: Rgb) => `#${c.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours. */
export function contrast(a: string, b: string): number {
  const ca = parseHex(a), cb = parseHex(b);
  if (!ca || !cb) return 1;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The type colour darkened (same hue) until it reaches `min` : 1 on white.
 *  A colour that already does is returned as is. */
export function tickColor(hex: string, min = TICK_CONTRAST): string {
  const c = parseHex(hex);
  if (!c) return '#525252';
  if (contrast(toHex(c), '#ffffff') >= min) return toHex(c);
  let lo = 0, hi = 1;
  // Binary search on the darkening factor: the smallest change that reaches min.
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const d = toHex(c.map(v => v * (1 - mid)) as Rgb);
    if (contrast(d, '#ffffff') >= min) hi = mid; else lo = mid;
  }
  const out = toHex(c.map(v => v * (1 - hi)) as Rgb);
  return contrast(out, '#ffffff') >= min ? out : toHex(c.map(v => v * (1 - hi - 0.01)) as Rgb);
}

// ── nesting ─────────────────────────────────────────────────────────

export type NestingLevel = 'container' | 'widget' | 'part';

/** Structural types: drawn as containers even before their children are
 *  marked. */
const CONTAINER_TYPES = new Set([
  'Organisation', 'Page', 'Scorecard', 'ModelPage', 'Container', 'TabSet', 'Tab', 'Section', 'ButtonContainer',
  'WebChildReference', 'InputView', 'CreateObjectView', 'InputSet', 'EditPage', 'EditPageColumnBreak', 'ButtonGroup',
]);

/** Field-like types: parts of a widget. */
const PART_TYPES = new Set([
  'TextInput', 'NumberInput', 'DateInput', 'ChoiceInput', 'BooleanInput', 'ReferenceInput', 'ButtonInput', 'Label',
  'ListInput', 'EditField', 'ActionButton', 'Button',
]);

/** Hosts up to this tall are parts whatever their type (tabs, menu
 *  buttons, links, chips). Same bound as the layout's small hosts. */
export const PART_MAX_HEIGHT = 48;

export interface NestingFacts {
  type?: string;
  /** The host holds another marked object. */
  hasMarkedChild: boolean;
  /** Host height in px (0 when unknown). */
  height: number;
  /** The badge is a link, an edit-field badge or a compact tile. */
  inline?: boolean;
}

export function nestingLevel(f: NestingFacts): NestingLevel {
  if (f.hasMarkedChild) return 'container';
  if (f.type && CONTAINER_TYPES.has(f.type) && !(f.height > 0 && f.height <= PART_MAX_HEIGHT)) return 'container';
  if (f.inline || (f.type && PART_TYPES.has(f.type)) || (f.height > 0 && f.height <= PART_MAX_HEIGHT)) return 'part';
  return 'widget';
}

// ── background ──────────────────────────────────────────────────────

export type Backdrop = 'light' | 'dark' | 'image';

/** One step of the walk from the host up: its computed background. */
export interface BackgroundSample {
  /** `background-color` as computed (`rgb(…)` / `rgba(…)` / `transparent`). */
  color: string;
  /** `background-image` as computed (`none`, `url(…)`, gradients). */
  image: string;
}

function parseCssColor(s: string): { rgb: Rgb; alpha: number } | null {
  const t = s.trim().toLowerCase();
  if (t === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  const hex = parseHex(t);
  if (hex) return { rgb: hex, alpha: 1 };
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (!m) return null;
  const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: a };
}

/** Luminance below this is a dark background (white text reads on it). */
const DARK_LUMINANCE = 0.18;

/**
 * What a host's marks sit on. `samples` run from the host outwards; the
 * first one that paints (an image, or a colour of alpha 0.5 and up)
 * decides. `media`: the host is a chart type or holds a picture, canvas or
 * chart SVG covering most of it.
 */
export function classifyBackdrop(samples: readonly BackgroundSample[], media = false): Backdrop {
  if (media) return 'image';
  for (const s of samples) {
    if (isPicture(s.image)) return 'image';
    const c = parseCssColor(s.color);
    if (!c || c.alpha < 0.5) continue;
    return luminance(c.rgb) < DARK_LUMINANCE ? 'dark' : 'light';
  }
  return 'light';
}

const isPicture = (image: string) => !!image && image !== 'none' && /url\(/i.test(image);

/** This step decides the backdrop: the walk up can stop here. */
export function samplePaints(s: BackgroundSample): boolean {
  if (isPicture(s.image)) return true;
  const c = parseCssColor(s.color);
  return !!c && c.alpha >= 0.5;
}

/** Chart types count as image backgrounds. */
export function isChartType(type?: string): boolean {
  return !!type && ((CHART_TYPES as readonly string[]).includes(type) || /Chart$/.test(type));
}

// ── locate ──────────────────────────────────────────────────────────

export interface Rect { top: number; left: number; bottom: number; right: number }

export interface LocatePlan {
  /** The target is at least partly in the viewport. */
  inView: boolean;
  /** Off screen: the edge the flag sits on, and its x (centre) or y. */
  edge: 'top' | 'bottom' | 'left' | 'right' | null;
  at: number;
}

/** Edge flag margin from the viewport corners. */
const FLAG_MARGIN = 60;

export function locatePlan(r: Rect, vw: number, vh: number): LocatePlan {
  const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  if (inView) return { inView, edge: null, at: 0 };
  const clampX = Math.max(FLAG_MARGIN, Math.min(vw - FLAG_MARGIN, (r.left + r.right) / 2));
  const clampY = Math.max(FLAG_MARGIN, Math.min(vh - FLAG_MARGIN, (r.top + r.bottom) / 2));
  if (r.bottom <= 0) return { inView, edge: 'top', at: clampX };
  if (r.top >= vh) return { inView, edge: 'bottom', at: clampX };
  return r.right <= 0 ? { inView, edge: 'left', at: clampY } : { inView, edge: 'right', at: clampY };
}

/** The spot ring around a located target: 3px outside, kept on screen. */
export function spotBox(r: Rect, vw: number, vh: number, pad = 3): Rect {
  return {
    top: Math.max(0, r.top - pad), left: Math.max(0, r.left - pad),
    bottom: Math.min(vh, r.bottom + pad), right: Math.min(vw, r.right + pad),
  };
}
