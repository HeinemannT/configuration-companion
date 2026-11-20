// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { CAPS, outermostElements, readWidget, wireBudget, wireText, type WireGeo, type WireItem } from '../wireframe';

/** A page laid out by hand: every element says its box in `data-r="x,y,w,h"`; text sits in its parent's box. */
function geo(now: () => number = () => 0): WireGeo {
  const box = (el: Element | null) => {
    const r = el?.getAttribute('data-r');
    if (!r) return null;
    const [x, y, w, h] = r.split(',').map(Number);
    return { x, y, w, h };
  };
  return {
    rect: el => box(el),
    lines: t => { const b = box(t.parentElement); return b ? [b] : []; },
    shown: el => !el.hasAttribute('data-hidden'),
    clips: el => el.hasAttribute('data-clip'),
    hides: el => el.hasAttribute('data-clip'),
    font: el => ({ size: 12, weight: /^(H\d|TH)$/.test(el.tagName) ? 700 : 400 }),
    now,
  };
}

const VIEW = { x: 0, y: 0, w: 1440, h: 900 };
function read(html: string, g: WireGeo = geo()): WireItem[] {
  document.body.innerHTML = html;
  const root = document.body.firstElementChild!;
  return readWidget(root, VIEW, g, wireBudget(g));
}
const texts = (items: WireItem[]): string[] => items.flatMap(i => (i.k === 'text' ? [i.text] : []));

describe('wireText', () => {
  it('folds spaces, drops icon glyphs and cuts long text', () => {
    expect(wireText('  Open \n risks  ')).toBe('Open risks');
    expect(wireText('x'.repeat(200))).toHaveLength(CAPS.chars);
    expect(wireText('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('readWidget: what a widget shows', () => {
  it('a heading, a label, a button and a field, each where it is', () => {
    const items = read(`<div data-r="0,0,600,300">
      <h3 data-r="10,10,200,20">Organisation details</h3>
      <label data-r="10,40,100,16">Owner</label>
      <input type="text" value="Jane Roe" data-r="120,40,200,24">
      <button data-r="10,80,90,28"><span data-r="20,86,70,16">Save</span></button>
    </div>`);
    expect(items).toContainEqual(expect.objectContaining({ k: 'text', text: 'Organisation details', strong: true, x: 10, y: 10 }));
    expect(items).toContainEqual(expect.objectContaining({ k: 'text', text: 'Owner' }));
    expect(items).toContainEqual(expect.objectContaining({ k: 'field', x: 120, y: 40, w: 200, h: 24 }));
    expect(items).toContainEqual(expect.objectContaining({ k: 'button', text: 'Save', x: 10, y: 80 }));
    // The caption is the button's, not a second text.
    expect(texts(items)).not.toContain('Save');
  });

  it('never draws an input value, a password or a hidden input', () => {
    const items = read(`<div data-r="0,0,600,300">
      <input type="password" value="secret1" data-r="10,10,200,24">
      <input type="hidden" value="secret2" data-r="10,40,200,24">
      <input type="text" value="secret3" data-r="10,70,200,24">
      <textarea data-r="10,100,200,60">secret4</textarea>
    </div>`);
    expect(JSON.stringify(items)).not.toMatch(/secret/);
    expect(items.filter(i => i.k === 'field')).toHaveLength(2);
  });

  it('leaves out what is hidden, scrolled away or outside the window, and Companion\'s own overlay', () => {
    const items = read(`<div data-r="0,0,600,300">
      <p data-r="10,10,100,16">Shown</p>
      <p data-r="10,30,100,16" data-hidden>Hidden</p>
      <p data-r="10,400,100,16">Scrolled away</p>
      <p data-r="10,50,100,16" aria-hidden="true">Icon</p>
      <span class="crev-label" data-r="10,70,100,16">TBL tbl_x</span>
      <div data-r="10,90,300,0" data-clip><input type="text" data-r="10,80,300,24"><span data-r="10,80,300,16">Filter</span></div>
      <div data-r="10,120,300,0"><span data-r="10,110,300,16">Overflowing</span></div>
      <script>var x = 1</script>
    </div>`);
    expect(texts(items)).toEqual(['Shown', 'Overflowing']);
    expect(items.filter(i => i.k === 'field')).toHaveLength(0);
  });

  it('a table: the header band, the first rows and how many more there are', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `<tr data-r="0,${40 + i * 20},600,20"><td data-r="0,${40 + i * 20},300,20">Risk ${i + 1}</td><td data-r="300,${40 + i * 20},300,20">High</td></tr>`).join('');
    const items = read(`<div data-r="0,0,600,300"><table data-r="0,20,600,240"><thead><tr data-r="0,20,600,20"><th data-r="0,20,300,20">Name</th><th data-r="300,20,300,20">Level</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    expect(items.filter(i => i.k === 'head')).toHaveLength(1);
    expect(texts(items).filter(t => t.startsWith('Risk'))).toHaveLength(CAPS.rows);
    expect(items.find(i => i.k === 'text' && i.text === 'Name')).toMatchObject({ strong: true });
    // Rows 7 and 8 are on screen inside the widget; 9 and 10 run past its bottom (300).
    expect(items).toContainEqual(expect.objectContaining({ k: 'more', text: `${10 - CAPS.rows} more rows` }));
  });

  it('a chart or an image is a placeholder named by its title or alt; small icons are left out', () => {
    const items = read(`<div data-r="0,0,600,300">
      <svg data-r="10,10,300,200" aria-label="Risks by status"><text data-r="20,190,40,12">Open</text></svg>
      <img alt="Company logo" data-r="400,10,120,60">
      <img alt="edit" data-r="400,100,16,16">
    </div>`);
    expect(items).toContainEqual(expect.objectContaining({ k: 'media', what: 'chart', text: 'Risks by status' }));
    expect(items).toContainEqual(expect.objectContaining({ k: 'media', what: 'image', text: 'Company logo' }));
    expect(items.filter(i => i.k === 'media')).toHaveLength(2);
    expect(texts(items)).toContain('Open');
  });

  it('stops at its caps: items per widget, and the time for the whole picture', () => {
    const many = Array.from({ length: 400 }, (_, i) => `<p data-r="0,${i % 280},100,10">Line ${i}</p>`).join('');
    expect(read(`<div data-r="0,0,600,300">${many}</div>`).length).toBe(CAPS.itemsPerWidget);
    let t = 0;
    const slow = geo(() => (t += 50));
    document.body.innerHTML = `<div data-r="0,0,600,300">${many}</div>`;
    const budget = wireBudget(slow);
    const items = readWidget(document.body.firstElementChild!, VIEW, slow, budget);
    expect(budget.cut).toBe(true);
    expect(items.length).toBeLessThan(CAPS.itemsPerWidget);
  });

  it('reads a widget once even when another widget sits inside it', () => {
    document.body.innerHTML = '<div id="a"><div id="b"></div></div><div id="c"></div>';
    const [a, b, c] = ['a', 'b', 'c'].map(id => document.getElementById(id)!);
    expect(outermostElements([b, a, c])).toEqual([a, c]);
  });
});

describe('readWidget: wrapped text', () => {
  it('shares the words out over the lines without breaking a word', () => {
    document.body.innerHTML = '<div data-r="0,0,600,300"><p data-r="0,0,300,40">Confirm the accountable recovery owner and the handover across the affected organisations</p></div>';
    const g: WireGeo = { ...geo(), lines: () => [{ x: 0, y: 0, w: 300, h: 20 }, { x: 0, y: 20, w: 120, h: 20 }] };
    const items = readWidget(document.body.firstElementChild!, VIEW, g, wireBudget(g));
    const lines = texts(items);
    expect(lines).toHaveLength(2);
    expect(lines.join(' ')).toBe('Confirm the accountable recovery owner and the handover across the affected organisations');
  });
});

describe('readWidget: content cut off by its own box', () => {
  it('a cell with an ellipsis: its text is drawn only within the cell, and what is past it not at all', () => {
    document.body.innerHTML = '<div data-r="0,0,600,300"><div data-r="0,0,200,20" data-clip><span data-r="0,0,380,20">Europe, Shared Services, Sweden, Austria</span><span data-r="390,0,100,20">South Africa</span></div></div>';
    const g = geo();
    const items = readWidget(document.body.firstElementChild!, VIEW, g, wireBudget(g));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ k: 'text', x: 0, w: 200 });
  });
});
