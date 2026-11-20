/**
 * What the Adjust panel does to an image before it is written: one colour,
 * a size, padding, SVG or PNG. Ported as vanilla TypeScript from the sister
 * project's icon batch (recolour, fit, padding, SVG clean-up, PNG export),
 * reduced to what the panel offers. The SVG part is text and DOM only and
 * is tested without a canvas; PNG export draws on a canvas.
 */

import { contentBounds, isTurned, NO_TURN, turnTransform, type Box, type Turn } from './svg-geometry';
import { hasStrokes, setStrokeWidth, swapSvgColors } from './svg-colors';

export type AdjustFormat = 'svg' | 'png';

export type ShapeKind = 'none' | 'circle' | 'square';

export interface AdjustSettings {
  /** `original` keeps the colours of the file; `one` paints all of it in `hex`;
   *  `swap` replaces the colours named in `map` (SVG only). */
  color: { mode: 'original' | 'one' | 'swap'; hex: string; map?: Readonly<Record<string, string>> };
  /** Square size in px; `keep` leaves the size of the file. */
  size: number | 'keep';
  /** Space around the image, px at the target size. */
  padding: number;
  format: AdjustFormat;
  /** Quarter turns and flips. */
  turn?: Turn;
  /** Crop to what is drawn. */
  trim?: boolean;
  /** A circle or rounded square in `hex` behind the image. */
  shape?: { kind: ShapeKind; hex: string };
  /** Stroke width on a 24 px grid (line icons only). */
  line?: number | 'keep';
}

/** How much of a badge's side the image keeps (the rest is the shape around it). */
export const SHAPE_CONTENT: Readonly<Record<Exclude<ShapeKind, 'none'>, number>> = { circle: 0.58, square: 0.62 };
/** The corner of a rounded square, as a part of its side. */
export const SQUARE_RADIUS = 0.22;

/** Does anything in the settings change the drawing (besides the format)? */
export function changesDrawing(s: AdjustSettings): boolean {
  return s.color.mode === 'one' || (s.color.mode === 'swap' && Object.keys(s.color.map ?? {}).length > 0)
    || s.size !== 'keep' || s.padding > 0 || isTurned(s.turn ?? NO_TURN) || !!s.trim
    || (s.shape?.kind ?? 'none') !== 'none' || (s.line ?? 'keep') !== 'keep';
}

export const SIZES: readonly number[] = [16, 24, 32, 48];

export const DEFAULT_ADJUST: AdjustSettings = {
  color: { mode: 'original', hex: '#1A56A0' },
  size: 'keep',
  padding: 0,
  format: 'png',
};

export interface ImageOutput {
  bytes: Uint8Array; mime: string; width: number; height: number;
  /** The content as BMP is sent it (content-encoding.ts), set by the page once. */ base64?: string;
  /** Trim was asked for and left the drawing as it was. */ trimSkipped?: boolean;
}

// ── SVG as text ─────────────────────────────────────────────────────

/** Tiny SVG minifier: no XML declaration, DOCTYPE, comments, title, desc or
 *  metadata; coordinates rounded to 2 decimals; white space collapsed. */
export function cleanSvg(source: string): string {
  let out = source;
  out = out.replace(/<\?xml[^?]*\?>\s*/g, '');
  out = out.replace(/<!DOCTYPE[^>]*>\s*/g, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<(?:\w+:)?title\b[\s\S]*?<\/(?:\w+:)?title>/g, '');
  out = out.replace(/<(?:\w+:)?desc\b[\s\S]*?<\/(?:\w+:)?desc>/g, '');
  out = out.replace(/<(?:\w+:)?metadata\b[\s\S]*?<\/(?:\w+:)?metadata>/g, '');
  out = out.replace(/-?\d+\.\d{3,}/g, m => {
    const n = Number(m);
    return Number.isFinite(n) ? Number(n.toFixed(2)).toString() : m;
  });
  out = out.replace(/>\s+</g, '><');
  out = out.replace(/\s{2,}/g, ' ');
  return out.trim();
}

/** Natural size of an SVG from its width and height, else its viewBox. */
export function svgNaturalSize(svgText: string): { width: number; height: number } {
  try {
    const svg = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
    const w = parseFloat(svg.getAttribute('width') || '');
    const h = parseFloat(svg.getAttribute('height') || '');
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  } catch { /* fall through */ }
  return { width: 24, height: 24 };
}

const PAINT_TAGS = new Set(['path', 'circle', 'rect', 'polygon', 'polyline', 'line', 'ellipse', 'g', 'use', 'text', 'tspan']);
const KEEP_PAINT = new Set(['none', 'inherit', 'transparent']);

function recolorDeclaration(value: string, color: string): string {
  return KEEP_PAINT.has(value.trim().toLowerCase()) || /^url\(/i.test(value.trim()) ? value : color;
}

/** `fill` and `stroke` in an inline style or a style sheet text. */
function recolorCssText(css: string, color: string): string {
  return css.replace(/(\b(?:fill|stroke)\s*:\s*)([^;}\n]+)/gi, (_m, prefix: string, value: string) => `${prefix}${recolorDeclaration(value, color)}`);
}

/** Every drawn colour of the SVG becomes `color`: attributes, inline
 *  styles and style sheets; `none` stays none, so a line icon stays a line
 *  icon. `currentColor` is replaced, since a file has no text colour to
 *  follow. A shape with no fill of its own, below a root with none, takes
 *  the colour through the root. */
export function recolorSvg(svg: Element, color: string): void {
  const walker = svg.ownerDocument.createTreeWalker(svg, 1 /* SHOW_ELEMENT */);
  let node: Element | null = walker.currentNode as Element;
  while (node) {
    const tag = node.tagName.toLowerCase();
    if (PAINT_TAGS.has(tag) || tag === 'svg') {
      for (const attr of ['fill', 'stroke']) {
        const v = node.getAttribute(attr);
        if (v !== null) node.setAttribute(attr, recolorDeclaration(v, color));
      }
      const style = node.getAttribute('style');
      if (style) node.setAttribute('style', recolorCssText(style, color));
    }
    if (tag === 'style' && node.textContent) node.textContent = recolorCssText(node.textContent, color);
    node = walker.nextNode() as Element | null;
  }
  // The default fill is black: give the root the colour when nothing says otherwise.
  if (!svg.hasAttribute('fill') && !/\bfill\s*:/i.test(svg.getAttribute('style') ?? '')) svg.setAttribute('fill', color);
}

const NS = 'http://www.w3.org/2000/svg';
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The viewBox of an SVG element, or its natural size from 0 0. */
function viewBoxOf(svg: Element, natural: { width: number; height: number }): Box {
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  return vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0
    ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] } : { x: 0, y: 0, w: natural.width, h: natural.height };
}

/** Wrap everything the SVG draws in one group (definitions and style sheets stay where they are). */
function wrapContent(svg: Element, transform: string): Element {
  const g = svg.ownerDocument.createElementNS(NS, 'g');
  g.setAttribute('transform', transform);
  const kids: Node[] = [];
  svg.childNodes.forEach(n => kids.push(n));
  for (const n of kids) {
    const tag = n.nodeType === 1 ? ((n as Element).localName || '').toLowerCase() : '';
    if (tag === 'defs' || tag === 'style') continue;
    g.appendChild(n);
  }
  svg.appendChild(g);
  return g;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export interface AdjustedSvg {
  svg: string; width: number; height: number;
  /** Trim was asked for and the drawing's outline could not be told (a mask, text …): left as it was. */
  trimSkipped?: boolean;
}

/** The SVG with the adjustments applied; its width and height. Throws for
 *  text that is not an SVG. Order: colours, line width, turn, trim, shape,
 *  padding, size. */
export function adjustSvgText(source: string, s: AdjustSettings): AdjustedSvg {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.tagName.toLowerCase() !== 'svg') throw new Error('Not a valid SVG');
  const natural = svgNaturalSize(source);
  let vb = viewBoxOf(svg, natural);
  const unit = natural.width / vb.w;
  let trimSkipped = false;

  if (s.color.mode === 'one') recolorSvg(svg, s.color.hex);
  else if (s.color.mode === 'swap' && s.color.map) swapSvgColors(svg, s.color.map);
  if (typeof s.line === 'number' && hasStrokes(svg)) setStrokeWidth(svg, s.line, Math.max(vb.w, vb.h));

  const turn = s.turn ?? NO_TURN;
  if (isTurned(turn)) {
    const t = turnTransform(vb, turn);
    wrapContent(svg, t.transform);
    vb = t.box;
  }
  if (s.trim) {
    const b = contentBounds(svg);
    if (b) vb = b; else trimSkipped = true;
  }
  const shape = s.shape?.kind ?? 'none';
  if (shape !== 'none') {
    // A badge is square: the drawing centred on it, the shape behind.
    const side = Math.max(vb.w, vb.h);
    const sq: Box = { x: vb.x - (side - vb.w) / 2, y: vb.y - (side - vb.h) / 2, w: side, h: side };
    const k = SHAPE_CONTENT[shape];
    const cx = sq.x + side / 2, cy = sq.y + side / 2;
    wrapContent(svg, `translate(${fmt(cx)} ${fmt(cy)}) scale(${fmt(k)}) translate(${fmt(-cx)} ${fmt(-cy)})`);
    const bg = shape === 'circle' ? doc.createElementNS(NS, 'circle') : doc.createElementNS(NS, 'rect');
    if (shape === 'circle') { bg.setAttribute('cx', fmt(cx)); bg.setAttribute('cy', fmt(cy)); bg.setAttribute('r', fmt(side / 2)); }
    else {
      bg.setAttribute('x', fmt(sq.x)); bg.setAttribute('y', fmt(sq.y)); bg.setAttribute('width', fmt(side)); bg.setAttribute('height', fmt(side));
      bg.setAttribute('rx', fmt(side * SQUARE_RADIUS));
    }
    bg.setAttribute('fill', s.shape!.hex);
    bg.setAttribute('stroke', 'none');
    const first = [...svg.children].find(c => !['defs', 'style'].includes((c.localName || '').toLowerCase()));
    svg.insertBefore(bg, first ?? null);
    vb = sq;
  }

  const width = s.size === 'keep' ? Math.round(vb.w * unit * 100) / 100 : s.size;
  const height = s.size === 'keep' ? Math.round(vb.h * unit * 100) / 100 : s.size;
  if (s.padding > 0) {
    const pad = Math.min(s.padding, Math.max(0, Math.min(width, height) / 2 - 1));
    const padX = (pad / width) * vb.w, padY = (pad / height) * vb.h;
    const scaleX = Math.max(0.01, (vb.w - 2 * padX) / vb.w), scaleY = Math.max(0.01, (vb.h - 2 * padY) / vb.h);
    // Scale about the viewBox origin: the drawing lands inside the padding.
    wrapContent(svg, `translate(${round2(vb.x + padX - vb.x * scaleX)} ${round2(vb.y + padY - vb.y * scaleY)}) scale(${round2(scaleX)} ${round2(scaleY)})`);
  }
  svg.setAttribute('viewBox', `${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.w)} ${fmt(vb.h)}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  return { svg: cleanSvg(new XMLSerializer().serializeToString(svg)), width, height, ...(trimSkipped ? { trimSkipped } : {}) };
}

// ── raster ──────────────────────────────────────────────────────────

/** Where a source of `natural` size is drawn on a `target` canvas with
 *  `padding` all round, kept in proportion and centred. */
export function computeDrawRect(
  natural: { width: number; height: number },
  target: { width: number; height: number },
  padding: number,
): { x: number; y: number; w: number; h: number } {
  const availW = Math.max(1, target.width - 2 * padding), availH = Math.max(1, target.height - 2 * padding);
  const scale = Math.min(availW / natural.width, availH / natural.height);
  const w = natural.width * scale, h = natural.height * scale;
  return { x: padding + (availW - w) / 2, y: padding + (availH - h) / 2, w, h };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read'));
    img.src = url;
  });
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<ImageOutput> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG export failed');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', width: canvas.width, height: canvas.height };
}

/** Draw an image source on a canvas of the target size and export it as PNG. */
async function drawToPng(
  url: string, natural: { width: number; height: number }, target: { width: number; height: number }, s: AdjustSettings, recolorByMask: boolean,
): Promise<ImageOutput> {
  const img = await loadImage(url);
  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The canvas is not available');
  const r = computeDrawRect(natural, target, s.padding);
  ctx.drawImage(img, r.x, r.y, r.w, r.h);
  if (recolorByMask) {
    // Keep the shape (its alpha), paint it in the one colour.
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = s.color.hex;
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.globalCompositeOperation = 'source-over';
  }
  return canvasPng(canvas);
}

export interface SourceImage { bytes: Uint8Array; mime: string }

/**
 * The image after the adjustments, as the bytes to write. An SVG stays an
 * SVG unless PNG is asked for; a picture (PNG, JPEG …) stays as it is until a color, size or
 * padding is asked for, then it becomes a PNG; `svg` is ignored for it.
 */
export async function processImage(source: SourceImage, s: AdjustSettings): Promise<ImageOutput> {
  const isSvg = source.mime === 'image/svg+xml';
  if (isSvg) {
    const text = new TextDecoder().decode(source.bytes);
    const out = adjustSvgText(text, s);
    if (s.format === 'svg') {
      return { bytes: new TextEncoder().encode(out.svg), mime: 'image/svg+xml', width: out.width, height: out.height, ...(out.trimSkipped ? { trimSkipped: true } : {}) };
    }
    // PNG from the adjusted SVG: padding and colour are already in it.
    const url = URL.createObjectURL(new Blob([out.svg], { type: 'image/svg+xml' }));
    try {
      const png = await drawToPng(url, out, out, { ...s, padding: 0 }, false);
      return out.trimSkipped ? { ...png, trimSkipped: true } : png;
    } finally { URL.revokeObjectURL(url); }
  }
  const url = URL.createObjectURL(new Blob([source.bytes as BlobPart], { type: source.mime }));
  try {
    const img = await loadImage(url);
    const natural = { width: img.naturalWidth || 24, height: img.naturalHeight || 24 };
    // Nothing asked for: the picture is written as it is (a photo stays a JPEG, not a larger PNG).
    // Swapping single colours is for SVG files: a picture ignores it.
    const raster = { ...s, color: s.color.mode === 'swap' ? { ...s.color, mode: 'original' as const } : s.color };
    if (!changesDrawing(raster)) return { bytes: source.bytes, mime: source.mime, ...natural };
    return await drawRaster(img, natural, raster);
  } finally { URL.revokeObjectURL(url); }
}

/** The bounds of the pixels that are not (nearly) transparent, or null for an empty picture. */
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number, threshold = 8): { x: number; y: number; w: number; h: number } | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function canvas2d(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The canvas is not available');
  return { canvas, ctx };
}

/** A picture through the same steps as an SVG: turn, trim, one colour, shape, padding, size. */
async function drawRaster(img: HTMLImageElement, natural: { width: number; height: number }, s: AdjustSettings): Promise<ImageOutput> {
  const turn = s.turn ?? NO_TURN;
  const across = turn.rotate === 90 || turn.rotate === 270;
  // 1. The picture turned, at its own size.
  let a = canvas2d(across ? natural.height : natural.width, across ? natural.width : natural.height);
  a.ctx.translate(a.canvas.width / 2, a.canvas.height / 2);
  if (turn.rotate) a.ctx.rotate((turn.rotate * Math.PI) / 180);
  a.ctx.scale(turn.flipH ? -1 : 1, turn.flipV ? -1 : 1);
  a.ctx.drawImage(img, -natural.width / 2, -natural.height / 2, natural.width, natural.height);
  a.ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 2. Trimmed to what is drawn (a picture with no transparency stays as it is).
  if (s.trim) {
    const b = alphaBounds(a.ctx.getImageData(0, 0, a.canvas.width, a.canvas.height).data, a.canvas.width, a.canvas.height);
    if (b && (b.w < a.canvas.width || b.h < a.canvas.height)) {
      const c = canvas2d(b.w, b.h);
      c.ctx.drawImage(a.canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      a = c;
    }
  }
  // 3. One colour: keep the shape (its alpha), paint it.
  if (s.color.mode === 'one') {
    a.ctx.globalCompositeOperation = 'source-in';
    a.ctx.fillStyle = s.color.hex;
    a.ctx.fillRect(0, 0, a.canvas.width, a.canvas.height);
    a.ctx.globalCompositeOperation = 'source-over';
  }
  const own = { width: a.canvas.width, height: a.canvas.height };
  const shape = s.shape?.kind ?? 'none';
  const side = Math.max(own.width, own.height);
  const target = s.size !== 'keep' ? { width: s.size, height: s.size } : shape !== 'none' ? { width: side, height: side } : own;
  const out = canvas2d(target.width, target.height);
  if (shape !== 'none') {
    // 4. The shape fills the space inside the padding; the picture sits on it.
    const pad = Math.min(s.padding, target.width / 2 - 1);
    const d = Math.min(target.width, target.height) - 2 * pad;
    const x = (target.width - d) / 2, y = (target.height - d) / 2;
    out.ctx.fillStyle = s.shape!.hex;
    out.ctx.beginPath();
    if (shape === 'circle') out.ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
    else out.ctx.roundRect(x, y, d, d, d * SQUARE_RADIUS);
    out.ctx.fill();
    const inset = pad + (d * (1 - SHAPE_CONTENT[shape])) / 2;
    const r = computeDrawRect(own, target, inset);
    out.ctx.drawImage(a.canvas, r.x, r.y, r.w, r.h);
  } else {
    const r = computeDrawRect(own, target, s.padding);
    out.ctx.drawImage(a.canvas, r.x, r.y, r.w, r.h);
  }
  return canvasPng(out.canvas);
}

/** A short word for what the settings do, for the confirm bar. */
export function describeAdjust(s: AdjustSettings): string {
  const parts: string[] = [];
  if (s.color.mode === 'one') parts.push(s.color.hex);
  if (s.size !== 'keep') parts.push(`${s.size} px`);
  if (s.padding > 0) parts.push(`padding ${s.padding}`);
  parts.push(s.format.toUpperCase());
  return parts.join(', ');
}
