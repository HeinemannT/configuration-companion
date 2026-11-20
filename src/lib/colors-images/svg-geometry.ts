/**
 * Where an SVG draws, without a browser layout: the bounds of its shapes
 * (paths, rectangles, circles, ellipses, lines, polygons, embedded pictures
 * and `<use>` of them) through their transforms, with half the stroke width
 * added where a stroke is drawn. Curves and arcs are sampled. A drawing
 * whose outline the shapes do not tell (text, a mask, a clip path, a filter,
 * markers, a pattern fill) gives no bounds: trimming then leaves it alone.
 * Also the transforms of Turn. DOM only, no canvas.
 */

export type Matrix = [number, number, number, number, number, number];
export interface Box { x: number; y: number; w: number; h: number }
type Pt = [number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const apply = (m: Matrix, [x, y]: Pt): Pt => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const nums = (s: string): number[] => (s.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/** The matrix of an SVG `transform` attribute. */
export function parseTransform(text: string | null): Matrix {
  let m: Matrix = IDENTITY;
  if (!text) return m;
  for (const [, fn, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = nums(args);
    let t: Matrix = IDENTITY;
    if (fn === 'matrix' && a.length === 6) t = a as Matrix;
    else if (fn === 'translate') t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      const cx = a[1] ?? 0, cy = a[2] ?? 0;
      t = multiply(multiply([1, 0, 0, 1, cx, cy], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewX') t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = multiply(m, t);
  }
  return m;
}

// ── paths ───────────────────────────────────────────────────────────

const STEPS = 12;

function cubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, out: Pt[]): void {
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS, u = 1 - t;
    out.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
}

function quad(p0: Pt, p1: Pt, p2: Pt, out: Pt[]): void {
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

/** An elliptical arc (SVG endpoint form), sampled. */
function arc(p0: Pt, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, p1: Pt, out: Pt[]): void {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry || (p0[0] === p1[0] && p0[1] === p1[1])) { out.push(p1); return; }
  const phi = (angle * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2, dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2, cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI; else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(4, Math.ceil(Math.abs(dt) / (Math.PI / 12)));
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    out.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
}

/** The points of a path's outline (curves sampled). */
export function pathPoints(d: string): Pt[] {
  const out: Pt[] = [];
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0, cmd = '';
  let cur: Pt = [0, 0], start: Pt = [0, 0], ctrl: Pt | null = null, qctrl: Pt | null = null;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]);
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): Pt => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const C = cmd.toUpperCase();
    if (C === 'Z') { cur = start; out.push(cur); ctrl = qctrl = null; continue; }
    if (!isNum()) continue;
    if (C === 'M') { cur = at(num(), num()); start = cur; out.push(cur); cmd = rel ? 'l' : 'L'; ctrl = qctrl = null; }
    else if (C === 'L') { cur = at(num(), num()); out.push(cur); ctrl = qctrl = null; }
    else if (C === 'H') { const x = num(); cur = [rel ? cur[0] + x : x, cur[1]]; out.push(cur); ctrl = qctrl = null; }
    else if (C === 'V') { const y = num(); cur = [cur[0], rel ? cur[1] + y : y]; out.push(cur); ctrl = qctrl = null; }
    else if (C === 'C') { const p1 = at(num(), num()), p2 = at(num(), num()), p3 = at(num(), num()); cubic(cur, p1, p2, p3, out); ctrl = p2; qctrl = null; cur = p3; }
    else if (C === 'S') {
      const p1: Pt = ctrl ? [2 * cur[0] - ctrl[0], 2 * cur[1] - ctrl[1]] : cur;
      const p2 = at(num(), num()), p3 = at(num(), num()); cubic(cur, p1, p2, p3, out); ctrl = p2; qctrl = null; cur = p3;
    } else if (C === 'Q') { const p1 = at(num(), num()), p2 = at(num(), num()); quad(cur, p1, p2, out); qctrl = p1; ctrl = null; cur = p2; }
    else if (C === 'T') {
      const p1: Pt = qctrl ? [2 * cur[0] - qctrl[0], 2 * cur[1] - qctrl[1]] : cur;
      const p2 = at(num(), num()); quad(cur, p1, p2, out); qctrl = p1; ctrl = null; cur = p2;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0;
      const p = at(num(), num()); arc(cur, rx, ry, rot, large, sweep, p, out); cur = p; ctrl = qctrl = null;
    } else i++;
  }
  return out;
}

// ── shapes ──────────────────────────────────────────────────────────

const lname = (e: Element) => (e.localName || e.tagName).toLowerCase();
const num = (e: Element, a: string, d = 0) => { const v = parseFloat(e.getAttribute(a) ?? ''); return Number.isFinite(v) ? v : d; };

function ellipsePoints(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < 24; i++) { const t = (i / 24) * 2 * Math.PI; out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]); }
  return out;
}

function shapePoints(e: Element): Pt[] | null {
  switch (lname(e)) {
    case 'path': return pathPoints(e.getAttribute('d') ?? '');
    case 'rect': case 'image': {
      const x = num(e, 'x'), y = num(e, 'y'), w = num(e, 'width'), h = num(e, 'height');
      return w > 0 && h > 0 ? [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] : [];
    }
    case 'circle': { const r = num(e, 'r'); return r > 0 ? ellipsePoints(num(e, 'cx'), num(e, 'cy'), r, r) : []; }
    case 'ellipse': { const rx = num(e, 'rx'), ry = num(e, 'ry'); return rx > 0 && ry > 0 ? ellipsePoints(num(e, 'cx'), num(e, 'cy'), rx, ry) : []; }
    case 'line': return [[num(e, 'x1'), num(e, 'y1')], [num(e, 'x2'), num(e, 'y2')]];
    case 'polyline': case 'polygon': { const n = nums(e.getAttribute('points') ?? ''); const out: Pt[] = []; for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; }
    default: return null;
  }
}

/** A presentation value from the element's attribute or inline style. */
function own(e: Element, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(e.getAttribute('style') ?? '');
  return m ? m[1].trim() : e.getAttribute(prop);
}

const UNRELIABLE_TAGS = new Set(['text', 'foreignobject', 'switch']);
const SKIP_TAGS = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata', 'script']);

interface Paint { fill: string; stroke: string; width: number }

/**
 * The bounds of what an SVG draws, in the units of its viewBox, or null when
 * its shapes do not tell them reliably. Invisible shapes (no fill and no
 * stroke, a common spacer rectangle) do not count.
 */
export function contentBounds(svg: Element): Box | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let unreliable = false;
  const sheet = [...svg.getElementsByTagName('style')].map(s => s.textContent ?? '').join('\n');
  // A style sheet can set paints the attributes do not show: count every shape's possible stroke at the widest width it names.
  const sheetWidth = Math.max(0, ...[...sheet.matchAll(/stroke-width\s*:\s*([\d.]+)/gi)].map(m => Number(m[1])));
  const sheetStroke = /\bstroke\s*:\s*(?!none)/i.test(sheet);
  const sheetFill = /\bfill\s*:/i.test(sheet);
  const byId = new Map<string, Element>();
  for (const e of svg.querySelectorAll('[id]')) byId.set(e.getAttribute('id')!, e);

  const visit = (e: Element, m: Matrix, inherited: Paint, depth: number): void => {
    if (unreliable || depth > 32) return;
    const tag = lname(e);
    if (SKIP_TAGS.has(tag)) return;
    if (UNRELIABLE_TAGS.has(tag)) { unreliable = true; return; }
    for (const a of ['mask', 'clip-path', 'filter', 'marker-start', 'marker-mid', 'marker-end']) {
      const v = own(e, a);
      if (v && v !== 'none') { unreliable = true; return; }
    }
    if ((own(e, 'display') ?? '') === 'none') return;
    const fill = own(e, 'fill') ?? inherited.fill;
    const stroke = own(e, 'stroke') ?? inherited.stroke;
    const sw = own(e, 'stroke-width');
    const paint: Paint = { fill, stroke, width: sw !== null && Number.isFinite(parseFloat(sw)) ? parseFloat(sw) : inherited.width };
    if (/^url\(/i.test(paint.fill) && !/gradient/i.test(byId.get(paint.fill.replace(/^url\(\s*#?|\s*\)$/g, ''))?.localName ?? '')) { unreliable = true; return; }
    const mm = multiply(m, parseTransform(e.getAttribute('transform')));
    if (tag === 'use') {
      const ref = byId.get((e.getAttribute('href') ?? e.getAttribute('xlink:href') ?? e.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '').replace(/^#/, ''));
      if (!ref) return;
      const shifted = multiply(mm, [1, 0, 0, 1, num(e, 'x'), num(e, 'y')]);
      if (lname(ref) === 'symbol') { for (const c of ref.children) visit(c, shifted, paint, depth + 1); }
      else visitShape(ref, shifted, paint, depth + 1);
      return;
    }
    if (tag === 'g' || tag === 'a' || tag === 'svg') { for (const c of e.children) visit(c, mm, paint, depth + 1); return; }
    visitShape(e, mm, paint, depth);
  };

  const visitShape = (e: Element, m: Matrix, inherited: Paint, depth: number): void => {
    const tag = lname(e);
    if (tag === 'g' || tag === 'symbol' || tag === 'use') { visit(e, m, inherited, depth); return; }
    if (UNRELIABLE_TAGS.has(tag)) { unreliable = true; return; }
    const fill = own(e, 'fill') ?? inherited.fill;
    const stroke = own(e, 'stroke') ?? inherited.stroke;
    const sw = own(e, 'stroke-width');
    const width = sw !== null && Number.isFinite(parseFloat(sw)) ? parseFloat(sw) : inherited.width;
    const mm = multiply(m, parseTransform(e.getAttribute('transform')));
    const pts = shapePoints(e);
    if (!pts) return;
    const isImage = tag === 'image';
    const filled = isImage || fill.trim().toLowerCase() !== 'none' || sheetFill;
    const stroked = !isImage && (stroke.trim().toLowerCase() !== 'none' || sheetStroke);
    if ((!filled && !stroked) || !pts.length) return;
    const half = stroked ? Math.max(width, sheetStroke ? sheetWidth : 0) / 2 : 0;
    const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
    for (const p of pts) {
      const [x, y] = apply(mm, p);
      minX = Math.min(minX, x - half * scale); maxX = Math.max(maxX, x + half * scale);
      minY = Math.min(minY, y - half * scale); maxY = Math.max(maxY, y + half * scale);
    }
  };

  const rootPaint: Paint = { fill: own(svg, 'fill') ?? 'black', stroke: own(svg, 'stroke') ?? 'none', width: parseFloat(own(svg, 'stroke-width') ?? '1') || 1 };
  for (const c of svg.children) visit(c, IDENTITY, rootPaint, 0);
  if (unreliable || !Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) return null;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r(minX), y: r(minY), w: r(maxX - minX), h: r(maxY - minY) };
}

// ── turn ────────────────────────────────────────────────────────────

export interface Turn { rotate: 0 | 90 | 180 | 270; flipH: boolean; flipV: boolean }
export const NO_TURN: Turn = { rotate: 0, flipH: false, flipV: false };
export const isTurned = (t: Turn): boolean => t.rotate !== 0 || t.flipH || t.flipV;

/** A quarter turn more (`1`) or less (`-1`). */
export function rotateBy(t: Turn, dir: 1 | -1): Turn {
  return { ...t, rotate: (((t.rotate + dir * 90) % 360 + 360) % 360) as Turn['rotate'] };
}

/** A flip as seen on screen: after a quarter turn, a left-right flip of what
 *  is shown is an up-down flip of the drawing (the flip is applied first). */
export function flip(t: Turn, axis: 'h' | 'v'): Turn {
  const across = t.rotate === 90 || t.rotate === 270;
  const h = (axis === 'h') !== across;
  const next = h ? { ...t, flipH: !t.flipH } : { ...t, flipV: !t.flipV };
  // Both flips are a half turn: keep the state simple.
  if (next.flipH && next.flipV) return { rotate: ((next.rotate + 180) % 360) as Turn['rotate'], flipH: false, flipV: false };
  return next;
}

/** The transform that turns content of `box` about its centre, and the box it then fills. */
export function turnTransform(box: Box, t: Turn): { transform: string; box: Box } {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const swap = t.rotate === 90 || t.rotate === 270;
  const w = swap ? box.h : box.w, h = swap ? box.w : box.h;
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const parts = [`translate(${r(cx)} ${r(cy)})`];
  if (t.rotate) parts.push(`rotate(${t.rotate})`);
  if (t.flipH || t.flipV) parts.push(`scale(${t.flipH ? -1 : 1} ${t.flipV ? -1 : 1})`);
  parts.push(`translate(${r(-cx)} ${r(-cy)})`);
  return { transform: parts.join(' '), box: { x: r(cx - w / 2), y: r(cy - h / 2), w: r(w), h: r(h) } };
}
