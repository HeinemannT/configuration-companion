/**
 * Colour arithmetic of the Colors and images page: hex text, HSV for the
 * picker, and the contrast of text on a colour. Pure.
 */

import { parseRgbTriple } from '../color-util';

export interface Rgb { r: number; g: number; b: number }
export interface Hsv { h: number; s: number; v: number }

const HEX6 = /^#[0-9A-F]{6}$/;

/** `#RRGGBB` (upper case) from what a person types: `1a56a0`, `#1A5`,
 *  `#1a56a0`. null when it is not a colour. */
export function normalizeHex(input: string): string | null {
  const t = input.trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{3}$/.test(t)) return `#${t[0]}${t[0]}${t[1]}${t[1]}${t[2]}${t[2]}`;
  const full = `#${t}`;
  return HEX6.test(full) ? full : null;
}

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function rgbToHex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map(v => byte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** `#RRGGBB` from the catalogue's `rgb(r,g,b)` text; null when it is not one. */
export function hexFromRgbText(text: string): string | null {
  const t = parseRgbTriple(text);
  return t ? rgbToHex({ r: t[0], g: t[1], b: t[2] }) : null;
}

export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
}

export const hexToHsv = (hex: string): Hsv => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: Hsv): string => rgbToHex(hsvToRgb(hsv));

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const [R, G, B] = [r, g, b].map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG contrast ratio of two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The contrast of white and of black text on `hex`, to one decimal. */
export function textOn(hex: string): { white: number; black: number } {
  const round = (n: number) => Math.round(n * 10) / 10;
  return { white: round(contrastRatio(hex, '#FFFFFF')), black: round(contrastRatio(hex, '#000000')) };
}

// ── HSL ─────────────────────────────────────────────────────────────

export interface Hsl { h: number; s: number; l: number }

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const hh = ((h % 360) + 360) % 360;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
}

// ── one value, three ways to type it ────────────────────────────────

export type ColorFormat = 'hex' | 'rgb' | 'hsl';

/** The value as the field shows it in a format: `#0F8A9D`, `15, 138, 157`, `187, 83%, 34%`. */
export function formatColor(hex: string, format: ColorFormat): string {
  if (format === 'hex') return hex;
  const rgb = hexToRgb(hex);
  if (format === 'rgb') return `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  const { h, s, l } = rgbToHsl(rgb);
  return `${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%`;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const SEP = String.raw`\s*[,\s]\s*`;

/** `#RRGGBB` from text in any of the three formats (with or without
 *  `rgb(`/`hsl(`), so a value can be typed or pasted either way. In the
 *  `rgb` and `hsl` formats three bare numbers are read in that format. */
export function parseColor(text: string, format: ColorFormat = 'hex'): string | null {
  const t = text.trim();
  const hex = normalizeHex(t);
  if (hex && (format === 'hex' || t.startsWith('#'))) return hex;
  const fn = /^(rgba?|hsla?)\s*\(([^)]*)\)$/i.exec(t);
  const kind = fn ? (fn[1].toLowerCase().startsWith('rgb') ? 'rgb' : 'hsl') : format === 'hex' ? null : format;
  const body = fn ? fn[2] : t;
  if (!kind) return null;
  const m = new RegExp(`^${NUM}(%?)${SEP}${NUM}(%?)${SEP}${NUM}(%?)(?:\\s*[,/]\\s*[\\d.]+%?)?$`).exec(body.trim());
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[3]), c = Number(m[5]);
  if (kind === 'rgb') {
    const ch = (v: number, pct: string) => (pct ? v * 2.55 : v);
    const vals = [ch(a, m[2]), ch(b, m[4]), ch(c, m[6])];
    if (vals.some(v => v < 0 || v > 255.5)) return null;
    return rgbToHex({ r: vals[0], g: vals[1], b: vals[2] });
  }
  if (b < 0 || b > 100 || c < 0 || c > 100) return null;
  return rgbToHex(hslToRgb({ h: a, s: b / 100, l: c / 100 }));
}

// ── how close two colours look (CIEDE2000) ──────────────────────────

interface Lab { L: number; a: number; b: number }

export function hexToLab(hex: string): Lab {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = lin(r), G = lin(g), B = lin(b);
  // sRGB to XYZ (D65), then to Lab.
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
  const Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** CIEDE2000 colour difference of two Lab colours. */
export function deltaE2000(x: Lab, y: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(x.a, x.b), C2 = Math.hypot(y.a, y.b);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + Math.pow(25, 7))));
  const a1 = (1 + G) * x.a, a2 = (1 + G) * y.a;
  const c1 = Math.hypot(a1, x.b), c2 = Math.hypot(a2, y.b);
  const hue = (bb: number, aa: number) => { if (bb === 0 && aa === 0) return 0; const h = Math.atan2(bb, aa) / rad; return h < 0 ? h + 360 : h; };
  const h1 = hue(x.b, a1), h2 = hue(y.b, a2);
  const dL = y.L - x.L, dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
  const Lm = (x.L + y.L) / 2, cm = (c1 + c2) / 2;
  let hm = h1 + h2;
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hm = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
    else hm = (h1 + h2) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hm - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(cm, 7) / (Math.pow(cm, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lm - 50, 2)) / Math.sqrt(20 + Math.pow(Lm - 50, 2));
  const Sc = 1 + 0.045 * cm, Sh = 1 + 0.015 * cm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dL / Sl, 2) + Math.pow(dC / Sc, 2) + Math.pow(dH / Sh, 2) + Rt * (dC / Sc) * (dH / Sh));
}

export const colorDistance = (a: string, b: string): number => deltaE2000(hexToLab(a), hexToLab(b));

/** Below this CIEDE2000 distance two colours read as the same colour side by
 *  side (about 2.3 is "just noticeable"; 3 leaves room for a re-typed brand value). */
export const CLOSE_DISTANCE = 3;

/** The nearest of `known` within CLOSE_DISTANCE of `hex` (an identical value counts), or null. */
export function closeMatch<T extends { hex: string }>(hex: string, known: readonly T[]): T | null {
  let best: T | null = null, bestD = Infinity;
  const lab = hexToLab(hex);
  for (const k of known) {
    const d = deltaE2000(lab, hexToLab(k.hex));
    if (d < bestD) { best = k; bestD = d; }
  }
  return best && bestD < CLOSE_DISTANCE ? best : null;
}

// ── white text on a colour ──────────────────────────────────────────

export const AA_TEXT = 4.5;

/** When white text on `hex` misses 4.5 but not by far (3 or more): the
 *  value of the same hue and saturation, darkened as little as needed for
 *  white to pass. null when white already passes or is far off (black text
 *  is then the plain answer). */
export function whitePassNudge(hex: string): string | null {
  const ratio = contrastRatio(hex, '#FFFFFF');
  if (ratio >= AA_TEXT || ratio < 3) return null;
  const hsl = rgbToHsl(hexToRgb(hex));
  // The lightest value of the hue that passes (each candidate is checked as whole bytes).
  let lo = 0, hi = hsl.l, found: string | null = null;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const cand = rgbToHex(hslToRgb({ ...hsl, l: mid }));
    if (contrastRatio(cand, '#FFFFFF') >= AA_TEXT) { found = cand; lo = mid; } else hi = mid;
  }
  return found;
}

// ── a scale from one colour ─────────────────────────────────────────

/** The five steps of a scale: the base is 500. */
export const SCALE_STEPS = [100, 300, 500, 700, 900] as const;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** Five steps from light to dark: tints toward white, the base, shades toward black. */
export function scaleFrom(hex: string): Array<{ step: (typeof SCALE_STEPS)[number]; hex: string }> {
  const base = hexToRgb(hex);
  const white = { r: 255, g: 255, b: 255 }, black = { r: 0, g: 0, b: 0 };
  return [
    { step: 100, hex: rgbToHex(mix(base, white, 0.86)) },
    { step: 300, hex: rgbToHex(mix(base, white, 0.48)) },
    { step: 500, hex },
    { step: 700, hex: rgbToHex(mix(base, black, 0.3)) },
    { step: 900, hex: rgbToHex(mix(base, black, 0.62)) },
  ];
}
