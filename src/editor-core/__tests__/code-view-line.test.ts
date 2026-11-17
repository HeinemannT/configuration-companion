// @vitest-environment happy-dom
/**
 * renderCodeLine: the one renderer of a read-only Extended Code line, with
 * the layers each surface draws over it (search hits, changed words,
 * reference links, sibling keys).
 */
import { describe, expect, it } from 'vitest';
import { renderCodeLine } from '../code-view';

const html = (nodes: Node[]) => { const d = document.createElement('div'); d.append(...nodes); return d.innerHTML; };
const wrapIn = (tag: string, cls = '') => () => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

describe('renderCodeLine', () => {
  it('colours tokens as s-<kind> spans and keeps the text', () => {
    const nodes = renderCodeLine('IF x THEN');
    expect(html(nodes)).toBe('<span class="s-kw">IF</span> x <span class="s-kw">THEN</span>');
  });

  it('plain: no colouring', () => {
    expect(html(renderCodeLine('IF x', { plain: true }))).toBe('IF x');
  });

  it('a layer wraps its range; one element per range, split at token edges', () => {
    const mark = (i: number) => { const m = document.createElement('mark'); m.dataset.m = String(i); return m; };
    const out = html(renderCodeLine('IF xy THEN', { layers: [{ ranges: [[1, 4]], wrap: mark }] }));
    expect(out).toBe('<span class="s-kw">I</span><mark data-m="0"><span class="s-kw">F</span> x</mark>y <span class="s-kw">THEN</span>');
  });

  it('nested layers: the inner element sits inside the outer one; a shared key merges ranges', () => {
    const out = html(renderCodeLine('ab cd', {
      layers: [
        { ranges: [[0, 5]], wrap: wrapIn('button', 'xref') },
        { ranges: [[0, 2], [2, 3]], wrap: wrapIn('span', 'chg'), key: () => true },
      ],
    }));
    expect(out).toBe('<button class="xref"><span class="chg">ab </span>cd</button>');
  });

  it('marks sibling keys', () => {
    const out = html(renderCodeLine('total := 1', { keys: new Set(['total']) }));
    expect(out).toContain('<span class="s-key">total</span>');
  });
});
