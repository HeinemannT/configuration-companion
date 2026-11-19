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
