/**
 * @vitest-environment happy-dom
 *
 * The SVG side of the new Adjust tools against awkward, real-world-like
 * files: colours swapped one by one, line width, turn, trim and shape.
 */
import { describe, expect, it } from 'vitest';
import { adjustSvgText, alphaBounds, changesDrawing, DEFAULT_ADJUST, type AdjustSettings } from '../image-process';
import { CURRENT_COLOR, hasStrokes, paintKey, svgColorsOfText } from '../svg-colors';
import { contentBounds, flip, parseTransform, pathPoints, rotateBy, turnTransform, NO_TURN } from '../svg-geometry';

const SVG = (body: string, attrs = 'viewBox="0 0 24 24"') => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`;

const FIX = {
  /** A line icon in the Lucide style: stroke on the root, currentColor. */
  stroke: SVG('<path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/>', 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'),
  /** Fills in inline styles and a style sheet, as design tools export them. */
  styled: SVG('<style>.a{fill:#14324A}.b{fill:#e07b24;stroke:none}</style><path class="a" d="M2 2h10v10H2z"/><circle class="b" cx="18" cy="18" r="3"/><rect x="14" y="2" width="6" height="6" style="fill: rgb(15, 138, 157)"/>'),
  /** A gradient by reference: the stops are the colours. */
  gradient: SVG('<defs><linearGradient id="g"><stop offset="0" stop-color="#5FB7D4"/><stop offset="1" style="stop-color:#14324A"/></linearGradient></defs><rect x="2" y="2" width="20" height="20" fill="url(#g)"/>'),
  /** A mask: its white is a shape, not a colour; trim cannot tell the outline. */
  masked: SVG('<mask id="m"><rect width="24" height="24" fill="#fff"/><circle cx="12" cy="12" r="4" fill="#000"/></mask><circle cx="12" cy="12" r="10" fill="#0F8A9D" mask="url(#m)"/>'),
  /** An embedded picture keeps its colours; its box is drawn. */
  raster: SVG('<image x="4" y="6" width="10" height="8" href="data:image/png;base64,iVBORw0KGgo="/><path d="M16 4h4v4h-4z" fill="red"/>'),
  /** No viewBox, no fill: drawn black by default, sized by width and height. */
  noViewBox: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><path d="M4 4h8v8H4z"/></svg>',
  /** `<use>` of a symbol, and the Material spacer that draws nothing. */
  use: SVG('<defs><symbol id="s"><path d="M0 0h4v4H0z"/></symbol></defs><path d="M0 0h24v24H0z" fill="none"/><use href="#s" x="10" y="10" fill="#1C2430"/>'),
};

const swap = (map: Record<string, string>): AdjustSettings => ({ ...DEFAULT_ADJUST, format: 'svg', color: { mode: 'swap', hex: '#000000', map } });

describe('the colours of an SVG', () => {
  it('reads fill and stroke attributes, inline styles, style sheets and gradient stops', () => {
    expect(svgColorsOfText(FIX.styled).map(c => c.key).sort()).toEqual(['#0F8A9D', '#14324A', '#E07B24']);
    expect(svgColorsOfText(FIX.gradient).map(c => c.key).sort()).toEqual(['#14324A', '#5FB7D4']);
  });

  it('lists currentColor as one entry and the default black of a shape without fill', () => {
    expect(svgColorsOfText(FIX.stroke).map(c => c.key)).toEqual([CURRENT_COLOR]);
    expect(svgColorsOfText(FIX.noViewBox).map(c => c.key)).toEqual(['#000000']);
  });

  it('leaves out the paint of a mask, url() paints and an embedded picture', () => {
    expect(svgColorsOfText(FIX.masked).map(c => c.key)).toEqual(['#0F8A9D']);
    expect(svgColorsOfText(FIX.raster).map(c => c.key)).toEqual(['#FF0000']);
    expect(paintKey('url(#g)')).toBeNull();
    expect(paintKey('none')).toBeNull();
    expect(paintKey('#abc')).toBe('#AABBCC');
    expect(paintKey('#11223380')).toBe('#112233');
  });

  it('swaps one colour and keeps the others, in attributes, styles, sheets and stops', () => {
    const out = adjustSvgText(FIX.styled, swap({ '#E07B24': '#C2453B', '#0F8A9D': '#14324A' })).svg;
    expect(out).toContain('fill:#C2453B');
    expect(out).toMatch(/fill:\s*#14324A"/);
    expect(out).toContain('.a{fill:#14324A}');
    expect(out).not.toMatch(/e07b24|0F8A9D|rgb\(15/i);
    const g = adjustSvgText(FIX.gradient, swap({ '#5FB7D4': '#E3F4F7' })).svg;
    expect(g).toContain('stop-color="#E3F4F7"');
    expect(g).toContain('stop-color:#14324A');
    expect(g).toContain('fill="url(#g)"');
  });

  it('swaps currentColor, the default black through the root, and leaves masks and pictures alone', () => {
    expect(adjustSvgText(FIX.stroke, swap({ [CURRENT_COLOR]: '#14324A' })).svg).toMatch(/<svg[^>]* stroke="#14324A"/);
    expect(adjustSvgText(FIX.noViewBox, swap({ '#000000': '#0F8A9D' })).svg).toMatch(/<svg[^>]* fill="#0F8A9D"/);
    const m = adjustSvgText(FIX.masked, swap({ '#FFFFFF': '#FF0000', '#0F8A9D': '#14324A' })).svg;
    expect(m).toContain('<rect width="24" height="24" fill="#fff"/>');
    expect(m).toContain('fill="#14324A"');
  });

  it('counts a swap with no colour chosen as no change', () => {
    expect(changesDrawing(swap({}))).toBe(false);
    expect(changesDrawing(swap({ '#000000': '#FFFFFF' }))).toBe(true);
    expect(changesDrawing({ ...DEFAULT_ADJUST, turn: { rotate: 90, flipH: false, flipV: false } })).toBe(true);
  });
});

describe('line width', () => {
  it('is offered for line icons only, and scales to the viewBox', () => {
    expect(hasStrokes(new DOMParser().parseFromString(FIX.stroke, 'image/svg+xml').documentElement)).toBe(true);
    expect(hasStrokes(new DOMParser().parseFromString(FIX.styled, 'image/svg+xml').documentElement)).toBe(false);
    const out = adjustSvgText(FIX.stroke, { ...DEFAULT_ADJUST, format: 'svg', line: 1.5 }).svg;
    expect(out).toMatch(/<svg[^>]* stroke-width="1.5"/);
    const big = adjustSvgText(FIX.stroke.replace('viewBox="0 0 24 24"', 'viewBox="0 0 48 48"'), { ...DEFAULT_ADJUST, format: 'svg', line: 1.5 }).svg;
    expect(big).toMatch(/stroke-width="3"/);
    // A filled icon is not changed by a line width.
    expect(adjustSvgText(FIX.styled, { ...DEFAULT_ADJUST, format: 'svg', line: 2 }).svg).not.toContain('stroke-width');
  });
});

describe('geometry', () => {
  it('parses transforms and samples paths, arcs and curves', () => {
    expect(parseTransform('translate(2 3) scale(2)')).toEqual([2, 0, 0, 2, 2, 3]);
    const r = parseTransform('rotate(90 12 12)');
    expect(r.map(n => Math.round(n))).toEqual([0, 1, -1, 0, 24, 0]);
    const xs = pathPoints('M2 12a10 10 0 0 0 20 0').map(p => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(22, 0);
    const c = pathPoints('M0 0C0 10 10 10 10 0').map(p => p[1]);
    expect(Math.max(...c)).toBeCloseTo(7.5, 1);
    expect(pathPoints('m1 1h2v2h-2z')).toEqual([[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]);
  });

  it('finds what is drawn, with half the stroke, through transforms and <use>, without spacers', () => {
    const b = (t: string) => contentBounds(new DOMParser().parseFromString(t, 'image/svg+xml').documentElement);
    expect(b(FIX.stroke)).toEqual({ x: 3, y: 3, w: 18, h: 17 });
    expect(b(FIX.use)).toEqual({ x: 10, y: 10, w: 4, h: 4 });
    expect(b(FIX.raster)).toEqual({ x: 4, y: 4, w: 16, h: 10 });
    expect(b(SVG('<g transform="translate(10 0)"><rect width="2" height="2"/></g>'))).toEqual({ x: 10, y: 0, w: 2, h: 2 });
    expect(b(FIX.gradient)).toEqual({ x: 2, y: 2, w: 20, h: 20 });
  });

  it('gives no bounds where the outline cannot be told', () => {
    const b = (t: string) => contentBounds(new DOMParser().parseFromString(t, 'image/svg+xml').documentElement);
    expect(b(FIX.masked)).toBeNull();
    expect(b(SVG('<text x="2" y="12">A</text>'))).toBeNull();
    expect(b(SVG('<path d="M2 2h4" filter="url(#f)"/>'))).toBeNull();
  });

  it('turns about the centre, swapping width and height on a quarter turn', () => {
    expect(turnTransform({ x: 0, y: 0, w: 32, h: 16 }, { rotate: 90, flipH: false, flipV: false }))
      .toEqual({ transform: 'translate(16 8) rotate(90) translate(-16 -8)', box: { x: 8, y: -8, w: 16, h: 32 } });
    expect(rotateBy(NO_TURN, -1).rotate).toBe(270);
    expect(rotateBy({ ...NO_TURN, rotate: 270 }, 1).rotate).toBe(0);
    // A left-right flip after a quarter turn flips the drawing up-down; both flips are a half turn.
    expect(flip({ ...NO_TURN, rotate: 90 }, 'h')).toEqual({ rotate: 90, flipH: false, flipV: true });
    expect(flip({ rotate: 0, flipH: true, flipV: false }, 'v')).toEqual({ rotate: 180, flipH: false, flipV: false });
  });
});

describe('turn, trim and shape on a file', () => {
  it('turns with one wrapping transform and a corrected viewBox and size', () => {
    const out = adjustSvgText(FIX.noViewBox, { ...DEFAULT_ADJUST, format: 'svg', turn: { rotate: 90, flipH: false, flipV: false } });
    expect(out).toMatchObject({ width: 16, height: 32 });
    expect(out.svg).toContain('viewBox="8 -8 16 32"');
    expect(out.svg.match(/transform=/g)).toHaveLength(1);
  });

  it('trims to the drawing, and leaves a masked drawing as it is', () => {
    const out = adjustSvgText(FIX.use, { ...DEFAULT_ADJUST, format: 'svg', trim: true });
    expect(out.svg).toContain('viewBox="10 10 4 4"');
    expect(out).toMatchObject({ width: 4, height: 4 });
    const m = adjustSvgText(FIX.masked, { ...DEFAULT_ADJUST, format: 'svg', trim: true });
    expect(m.trimSkipped).toBe(true);
    expect(m.svg).toContain('viewBox="0 0 24 24"');
  });

  it('puts a rounded square or a circle behind the drawing, which keeps its proportions', () => {
    const sq = adjustSvgText(FIX.stroke, { ...DEFAULT_ADJUST, format: 'svg', shape: { kind: 'square', hex: '#E9D8B4' } }).svg;
    expect(sq).toMatch(/<rect x="0" y="0" width="24" height="24" rx="5.28" fill="#E9D8B4" stroke="none"\/><g transform="translate\(12 12\) scale\(0.62\) translate\(-12 -12\)">/);
    const ci = adjustSvgText(FIX.noViewBox, { ...DEFAULT_ADJUST, format: 'svg', shape: { kind: 'circle', hex: '#14324A' } });
    // A wide drawing becomes a square badge.
    expect(ci.svg).toContain('viewBox="0 -8 32 32"');
    expect(ci.svg).toContain('<circle cx="16" cy="8" r="16" fill="#14324A" stroke="none"/>');
    expect(ci).toMatchObject({ width: 32, height: 32 });
  });

  it('combines turn, trim, shape, padding and size in that order', () => {
    const out = adjustSvgText(FIX.use, { ...DEFAULT_ADJUST, format: 'svg', trim: true, shape: { kind: 'circle', hex: '#0F8A9D' }, padding: 2, size: 24, turn: { rotate: 180, flipH: false, flipV: false } });
    expect(out).toMatchObject({ width: 24, height: 24 });
    expect(out.svg).toContain('viewBox="10 10 4 4"');
    expect(out.svg).toContain('<circle cx="12" cy="12" r="2" fill="#0F8A9D"');
  });
});

describe('trim on a picture', () => {
  it('finds the pixels that are not transparent', () => {
    const w = 4, h = 3, data = new Uint8ClampedArray(w * h * 4);
    data[(1 * w + 2) * 4 + 3] = 255;
    data[(2 * w + 1) * 4 + 3] = 200;
    expect(alphaBounds(data, w, h)).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(alphaBounds(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});
