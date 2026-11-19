/**
 * @vitest-environment happy-dom
 *
 * The SVG side of the Adjust panel (text and DOM, no canvas).
 */
import { describe, expect, it } from 'vitest';
import { adjustSvgText, base64ToBytes, bytesToBase64, cleanSvg, computeDrawRect, DEFAULT_ADJUST, describeAdjust, svgNaturalSize } from '../image-process';

const STROKE = '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><title>x</title><path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9" stroke="#ff0000"/></svg>';
const FILLED = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#00ff00"/><rect width="4" height="4" style="fill: blue; stroke:none"/><path d="M0 0h1.23456v1"/></svg>';
const one = (hex: string) => ({ ...DEFAULT_ADJUST, format: 'svg' as const, color: { mode: 'one' as const, hex } });

describe('SVG adjustments', () => {
  it('cleans an SVG the safe way', () => {
    const out = cleanSvg(STROKE);
    expect(out).not.toMatch(/<\?xml|<!--|<title/);
    expect(cleanSvg('<svg><path d="M1.23456 2"/></svg>')).toContain('M1.23 2');
  });

  it('reads the natural size from width and height, else the viewBox', () => {
    expect(svgNaturalSize('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>')).toEqual({ width: 40, height: 20 });
    expect(svgNaturalSize(FILLED)).toEqual({ width: 16, height: 16 });
    expect(svgNaturalSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toEqual({ width: 24, height: 24 });
  });

  it('keeps the colours of the file when asked to', () => {
    const out = adjustSvgText(FILLED, { ...DEFAULT_ADJUST, format: 'svg' });
    expect(out.svg).toContain('fill="#00ff00"');
    expect(out).toMatchObject({ width: 16, height: 16 });
  });

  it('paints a filled icon in one colour', () => {
    const out = adjustSvgText(FILLED, one('#1A56A0')).svg;
    expect(out).toContain('fill="#1A56A0"');
    expect(out).not.toContain('#00ff00');
    expect(out).toMatch(/fill:\s*#1A56A0/);
    // 'none' stays none: no stroke appears where there was none.
    expect(out).toMatch(/stroke:\s*none/);
  });

  it('paints a line icon in one colour and keeps it a line icon', () => {
    const out = adjustSvgText(STROKE, one('#1A56A0')).svg;
    expect(out).toMatch(/<svg[^>]* fill="none"/);
    expect(out).toMatch(/<svg[^>]* stroke="#1A56A0"/);
    expect(out).toMatch(/<path[^>]* stroke="#1A56A0"/);
    expect(out).not.toContain('currentColor');
    expect(out).not.toContain('#ff0000');
  });

  it('gives a drawing with no fill the colour through its root', () => {
    const out = adjustSvgText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>', one('#E8742A')).svg;
    expect(out).toMatch(/<svg[^>]* fill="#E8742A"/);
  });

  it('sets the size, and pads by scaling the drawing inside its viewBox', () => {
    const out = adjustSvgText(FILLED, { ...DEFAULT_ADJUST, format: 'svg', size: 24, padding: 2 });
    expect(out).toMatchObject({ width: 24, height: 24 });
    expect(out.svg).toMatch(/<svg[^>]* width="24"/);
    // 2 px of 24 on a 16 unit box: 1.33 units each side, a scale of 0.83.
    expect(out.svg).toContain('transform="translate(1.33 1.33) scale(0.83 0.83)"');
  });

  it('refuses text that is not an SVG', () => {
    expect(() => adjustSvgText('<html/>', { ...DEFAULT_ADJUST, format: 'svg' })).toThrow(/valid SVG/);
  });

  it('fits a picture in proportion, centred, inside the padding', () => {
    expect(computeDrawRect({ width: 100, height: 50 }, { width: 24, height: 24 }, 2)).toEqual({ x: 2, y: 7, w: 20, h: 10 });
    expect(computeDrawRect({ width: 10, height: 10 }, { width: 24, height: 24 }, 0)).toEqual({ x: 0, y: 0, w: 24, h: 24 });
  });

  it('round-trips bytes through base64 and describes the settings', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    expect(describeAdjust({ color: { mode: 'one', hex: '#1A56A0' }, size: 24, padding: 2, format: 'svg' })).toBe('#1A56A0, 24 px, padding 2, SVG');
    expect(describeAdjust(DEFAULT_ADJUST)).toBe('PNG');
  });
});
