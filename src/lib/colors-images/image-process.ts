/**
 * What the Adjust panel does to an image before it is written: one colour,
 * a size, padding, SVG or PNG. Ported as vanilla TypeScript from the sister
 * project's icon batch (recolour, fit, padding, SVG clean-up, PNG export),
 * reduced to what the panel offers. The SVG part is text and DOM only and
 * is tested without a canvas; PNG export draws on a canvas.
 */

export type AdjustFormat = 'svg' | 'png';

export interface AdjustSettings {
  /** `original` keeps the colours of the file. */
  color: { mode: 'original' | 'one'; hex: string };
  /** Square size in px; `keep` leaves the size of the file. */
  size: number | 'keep';
  /** Space around the image, px at the target size. */
  padding: number;
  format: AdjustFormat;
}

export const SIZES: readonly number[] = [16, 24, 32, 48];

export const DEFAULT_ADJUST: AdjustSettings = {
  color: { mode: 'original', hex: '#1A56A0' },
  size: 'keep',
  padding: 0,
  format: 'png',
};

export interface ImageOutput { bytes: Uint8Array; mime: string; width: number; height: number; /** The content as BMP is sent it (content-encoding.ts), set by the page once. */ base64?: string }

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

/** The SVG with the adjustments applied; its width and height. Throws for
 *  text that is not an SVG. */
export function adjustSvgText(source: string, s: AdjustSettings): { svg: string; width: number; height: number } {
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.tagName.toLowerCase() !== 'svg') throw new Error('Not a valid SVG');
  const natural = svgNaturalSize(source);
  const width = s.size === 'keep' ? natural.width : s.size;
  const height = s.size === 'keep' ? natural.height : s.size;
  let viewBox = svg.getAttribute('viewBox');
  if (!viewBox) { viewBox = `0 0 ${natural.width} ${natural.height}`; svg.setAttribute('viewBox', viewBox); }
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  if (s.color.mode === 'one') recolorSvg(svg, s.color.hex);
  if (s.padding > 0) {
    const [vx, vy, vw, vh] = viewBox.trim().split(/[\s,]+/).map(Number);
    const pad = Math.min(s.padding, Math.max(0, Math.min(width, height) / 2 - 1));
    const padX = (pad / width) * vw, padY = (pad / height) * vh;
    const scaleX = Math.max(0.01, (vw - 2 * padX) / vw), scaleY = Math.max(0.01, (vh - 2 * padY) / vh);
    const g = doc.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${round2(vx + padX)} ${round2(vy + padY)}) scale(${round2(scaleX)} ${round2(scaleY)})`);
    const kids: Node[] = [];
    svg.childNodes.forEach(n => kids.push(n));
    for (const n of kids) g.appendChild(n);
    svg.appendChild(g);
  }
  return { svg: cleanSvg(new XMLSerializer().serializeToString(svg)), width, height };
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
      return { bytes: new TextEncoder().encode(out.svg), mime: 'image/svg+xml', width: out.width, height: out.height };
    }
    // PNG from the adjusted SVG: padding and colour are already in it.
    const url = URL.createObjectURL(new Blob([out.svg], { type: 'image/svg+xml' }));
    try {
      return await drawToPng(url, out, out, { ...s, padding: 0 }, false);
    } finally { URL.revokeObjectURL(url); }
  }
  const url = URL.createObjectURL(new Blob([source.bytes as BlobPart], { type: source.mime }));
  try {
    const img = await loadImage(url);
    const natural = { width: img.naturalWidth || 24, height: img.naturalHeight || 24 };
    // Nothing asked for: the picture is written as it is (a photo stays a JPEG, not a larger PNG).
    if (s.color.mode === 'original' && s.size === 'keep' && s.padding === 0) return { bytes: source.bytes, mime: source.mime, ...natural };
    const target = s.size === 'keep' ? natural : { width: s.size, height: s.size };
    return await drawToPng(url, natural, target, s, s.color.mode === 'one');
  } finally { URL.revokeObjectURL(url); }
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
