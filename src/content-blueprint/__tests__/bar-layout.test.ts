/** @vitest-environment happy-dom */
/**
 * The floating Blueprint bar: one control height, one radius, one gap and one inset for both rows;
 * the exit button is a square icon button at the row's end; the bar is centred between insets (never
 * off the left edge), wraps inside itself, and sits under the portal's header band. Position and
 * z-index are inline (css-integrity rule).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BAR_GAP, BAR_TOP, barTop, placeBar } from '../bar-place';

const css = readFileSync('src/content-blueprint.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** Declarations of every top-level rule (outside @media) whose selector list contains `selector`, in
 *  source order: the later one wins at equal specificity. */
function decls(selector: string, inMedia = false): string[] {
  const out: string[] = [];
  let depth = 0, media = false, start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      const head = css.slice(start, i).trim();
      if (head.startsWith('@media')) { media = true; start = i + 1; depth++; continue; }
      const end = css.indexOf('}', i);
      if (media === inMedia && head.split(',').map(s => s.trim()).includes(selector)) out.push(css.slice(i + 1, end));
      i = end; start = i + 1;
      continue;
    }
    if (ch === '}' && media) { media = false; depth--; start = i + 1; }
  }
  return out;
}
const last = (selector: string, prop: string): string | undefined => {
  for (const d of decls(selector).reverse()) {
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(d);
    if (m) return m[1].trim();
  }
  return undefined;
};

const L = '#crev-blueprint-layer';
const CONTROLS = [
  `${L} .bp-header .bp-chip button`, `${L} .bp-header .bp-tabs>button`, `${L} .bp-header .bp-tabs>.bp-tab`,
  `${L} .bp-header .bp-tabs>.bp-amenu-trigger`, `${L} .bp-header .bp-chip .bp-page-chip`, `${L} .bp-header .bp-chip .bp-target`,
];

describe('Blueprint bar layout', () => {
  it('gives every control in both rows one height, one radius and border-box sizing', () => {
    for (const sel of CONTROLS) {
      expect(last(sel, 'height'), sel).toBe('var(--bp-ctl-h)');
      expect(last(sel, 'border-radius'), sel).toBe('var(--bp-r)');
      expect(last(sel, 'box-sizing'), sel).toBe('border-box');
    }
    expect(last(`${L} .bp-header`, '--bp-ctl-h')).toMatch(/^\d+px$/);
  });

  it('uses one gap and one inset for both rows, which wrap inside the bar', () => {
    for (const row of [`${L} .bp-header .bp-chip`, `${L} .bp-header .bp-tabs`]) {
      expect(last(row, 'padding'), row).toBe('var(--bp-bar-y) var(--bp-bar-x)');
      expect(last(row, 'gap'), row).toBe('var(--bp-ctl-gap)');
      expect(last(row, 'flex-wrap'), row).toBe('wrap');
    }
    expect(last(`${L} .bp-header .bp-commit-actions`, 'gap')).toBe('var(--bp-ctl-gap)');
    // The actions (and the exit button with them) end at the row's end, inset like the row's start.
    expect(last(`${L} .bp-header .bp-commit-actions`, 'margin-left')).toBe('auto');
  });

  it('draws the exit and the other icon buttons as squares of the control height', () => {
    expect(last(`${L} .bp-header .bp-chip button.bp-exit`, 'width')).toBe('var(--bp-ctl-h)');
    expect(last(`${L} .bp-header .bp-chip button.plain`, 'width')).toBe('var(--bp-ctl-h)');
    expect(last(`${L} .bp-header .bp-chip button.bp-exit`, 'padding')).toBe('0');
  });

  it('keeps disabled controls at their size', () => {
    const d = decls(`${L} .bp-header .bp-chip button:disabled`).join(';');
    expect(d).toContain('opacity');
    expect(d).not.toMatch(/height|padding|width|border-width/);
  });

  it('is centred between insets, never translated off the left edge, and no wider than the viewport', () => {
    expect(last(`${L} .bp-header`, 'transform')).toBe('none');
    expect(last(`${L} .bp-header`, 'margin')).toBe('0 auto');
    expect(last(`${L} .bp-header`, 'max-width')).toBe('calc(100vw - 16px)');
    expect(last(`${L} .bp-header`, 'width')).toBe('max-content');
  });
});

describe('Blueprint bar placement', () => {
  it('sits under the portal header band, or near the top when there is none', () => {
    expect(barTop(48)).toBe(48 + BAR_GAP);
    expect(barTop(0)).toBe(BAR_TOP);
    // A tall fixed layer is not a header.
    expect(barTop(600)).toBe(BAR_TOP);
  });

  it('sets position, insets and z-index inline', () => {
    const bar = document.createElement('div');
    placeBar(bar, 48);
    expect(bar.style.position).toBe('fixed');
    expect(bar.style.zIndex).toBe('50');
    expect(bar.style.top).toBe('56px');
    expect(bar.style.left).toBe(`${BAR_GAP}px`);
    expect(bar.style.right).toBe(`${BAR_GAP}px`);
  });
});
